/**
 * 长轮询主循环：getUpdates → 解析 → allowFrom 闸 → resolveAgent → 驱动 agent → 回复。
 * 跑到 abort 为止。错误退避、会话过期暂停、游标持久化。
 * 详见 docs/weixin-ilink-integration.md §2.2。
 */

import {
  getContextToken,
  loadContextTokens,
  readBuf,
  setContextToken,
  writeBuf,
} from "./accounts.js";
import { getUpdates } from "./ilink.js";
import { parseInbound } from "./inbound.js";
import type { ResolveAgent } from "./router.js";
import { runAgentOnce } from "./run-once.js";
import { sendText } from "./send.js";
import { handleSessionCommand } from "../session/commands.js";
import { formatCtx, type CompactionDeps } from "../session/compaction.js";
import type { SessionStore } from "../session/store.js";

const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_MS = 30_000;
const SESSION_EXPIRED_PAUSE_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_TIMEOUT_MS = 35_000;

/** Node fetch 的 "fetch failed" 真因在 err.cause 里，展开它好排查。 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cause = (err as any).cause;
  if (cause) {
    const detail = cause.code || cause.message || String(cause);
    return `${err.message}（cause: ${detail}）`;
  }
  return err.message;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface MonitorOpts {
  baseUrl: string;
  token: string;
  accountId: string;
  /** 白名单：只有这些 ilink_user_id 能驱动 agent。 */
  allowFrom: string[];
  resolveAgent: ResolveAgent;
  /** 按 from 隔离的会话存储。 */
  sessionStore: SessionStore;
  /** 上下文压缩依赖（model / apiKey / headers）。 */
  compaction: CompactionDeps;
  abortSignal: AbortSignal;
  log?: (msg: string) => void;
}

export async function runMonitor(opts: MonitorOpts): Promise<void> {
  const log = opts.log ?? ((m) => console.log(m));
  loadContextTokens(opts.accountId);
  let buf = readBuf(opts.accountId);
  let fails = 0;
  let timeout = DEFAULT_TIMEOUT_MS;

  log(`[weixin] 开始监听（account ${opts.accountId}），允许 ${opts.allowFrom.length} 个白名单用户`);

  while (!opts.abortSignal.aborted) {
    try {
      const started = Date.now();
      const resp = await getUpdates({
        baseUrl: opts.baseUrl,
        token: opts.token,
        get_updates_buf: buf,
        timeoutMs: timeout,
      });

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeout = resp.longpolling_timeout_ms;
      }

      const failed =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (failed) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          log(
            `[weixin] 会话过期（errcode ${SESSION_EXPIRED_ERRCODE}），暂停 ${SESSION_EXPIRED_PAUSE_MS / 60_000} 分钟；如持续请重新 opennote login`,
          );
          await sleep(SESSION_EXPIRED_PAUSE_MS, opts.abortSignal);
          continue;
        }
        fails += 1;
        log(`[weixin] getUpdates 失败 ret=${resp.ret} errcode=${resp.errcode} (${fails}/${MAX_CONSECUTIVE_FAILURES})`);
        await sleep(fails >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_DELAY_MS, opts.abortSignal);
        if (fails >= MAX_CONSECUTIVE_FAILURES) fails = 0;
        continue;
      }

      fails = 0;
      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        writeBuf(opts.accountId, buf);
      }

      for (const msg of resp.msgs ?? []) {
        if (opts.abortSignal.aborted) break;
        const inbound = parseInbound(msg);

        // 任何入站消息都先缓存它的 context_token（回显要用）
        if (inbound.contextToken && inbound.from) {
          setContextToken(opts.accountId, inbound.from, inbound.contextToken);
        }

        if (inbound.isGroup) continue; // MVP 跳过群
        if (!inbound.from || !inbound.body) continue;

        // 安全闸：非白名单一律不处理
        if (!opts.allowFrom.includes(inbound.from)) {
          log(`[weixin] 拒绝非白名单用户 ${inbound.from}`);
          continue;
        }

        const agent = opts.resolveAgent(inbound.from);
        if (!agent) {
          log(`[weixin] 没有 agent 可处理 ${inbound.from}`);
          continue;
        }

        log(`[weixin] ← ${inbound.from}: ${inbound.body.slice(0, 50)}`);
        // 按 from 取会话（接着上次聊）。
        const session = opts.sessionStore.get(inbound.from);

        // 先看是不是斜杠命令（/compact、/clear 等），是就直接处理、不喂 agent。
        // 命令操作 agent，所以先把会话载入 agent、处理完再存回。
        agent.state.messages = session.messages;
        const cmdReply = await handleSessionCommand(
          inbound.body,
          agent,
          opts.compaction,
        );
        if (cmdReply !== null) {
          session.messages = agent.state.messages;
          session.updatedAt = Date.now();
          opts.sessionStore.save(session);
          try {
            await sendText({
              baseUrl: opts.baseUrl,
              token: opts.token,
              to: inbound.from,
              text: cmdReply,
              contextToken: getContextToken(opts.accountId, inbound.from),
            });
            log(`[weixin] → ${inbound.from}: [命令] ${inbound.body.slice(0, 30)}`);
          } catch (err) {
            log(`[weixin] 回复失败 to=${inbound.from}: ${describeError(err)}`);
          }
          continue;
        }

        // run-once 内部已兜超时/错误。
        const result = await runAgentOnce(agent, session, inbound.body, {
          compaction: opts.compaction,
          abortSignal: opts.abortSignal,
          log,
        });
        opts.sessionStore.save(session);

        if (!result.reply) continue;

        // 每条回复都带上 ctx 用量；压缩了就标一下。
        const ctxLine = formatCtx(result.ctx);
        const text = result.compacted
          ? `${result.reply}\n\n${ctxLine}（已压缩）`
          : `${result.reply}\n\n${ctxLine}`;

        try {
          await sendText({
            baseUrl: opts.baseUrl,
            token: opts.token,
            to: inbound.from,
            text,
            contextToken: getContextToken(opts.accountId, inbound.from),
          });
          log(`[weixin] → ${inbound.from}: ${result.reply.slice(0, 50)} | ${ctxLine}`);
        } catch (err) {
          log(`[weixin] 回复失败 to=${inbound.from}: ${describeError(err)}`);
        }
      }

      // 服务端若不长轮询、立即返回空，加点节流避免空转打爆 API（长轮询时 elapsed≈timeout，不触发）。
      const elapsed = Date.now() - started;
      if ((resp.msgs?.length ?? 0) === 0 && elapsed < 2_000) {
        await sleep(1_500, opts.abortSignal);
      }
    } catch (err) {
      if (opts.abortSignal.aborted) break;
      fails += 1;
      log(`[weixin] 循环异常 (${fails}/${MAX_CONSECUTIVE_FAILURES}): ${describeError(err)}`);
      await sleep(fails >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_DELAY_MS, opts.abortSignal);
      if (fails >= MAX_CONSECUTIVE_FAILURES) fails = 0;
    }
  }

  log("[weixin] 监听已停止");
}
