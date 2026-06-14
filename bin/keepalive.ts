#!/usr/bin/env tsx
/**
 * 推送号保活：对「只用来推送、不收命令」的 bot 持续 getUpdates 长轮询，
 * 让会话 / CDN 媒体上传授权不过期（实测：被持续轮询的号从不掉，没轮询的号媒体上传会失效）。
 *
 * 不处理消息（推送号不接命令，收到也丢弃），只：advance buf 游标 + 缓存 context_token。
 * 默认保活 auto-skill 路由里的 news + tools 两个号；**不要**把 bridge 用的号传进来（会和 bridge 抢消息）。
 *
 * 用法：
 *   npx tsx bin/keepalive.ts                       # 保活 routing.json 的 news+tools
 *   npx tsx bin/keepalive.ts --account a@im.bot ... # 指定要保活的号
 *   npx tsx bin/keepalive.ts --routing <path>      # 指定 routing.json
 */
import fs from "node:fs";
import { DEFAULT_BASE_URL, getUpdates } from "../src/weixin/ilink.js";
import { parseInbound } from "../src/weixin/inbound.js";
import {
  listAccounts,
  resolveLatestBot,
  readBuf,
  writeBuf,
  loadContextTokens,
  setContextToken,
} from "../src/weixin/accounts.js";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const DEFAULT_ROUTING =
  "/Users/avlin/workspace/25videos/auto-skill/data/weixin-routing.json";

let ids: string[] = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--account") ids.push(argv[i + 1]!);
if (!ids.length) {
  try {
    const r = JSON.parse(fs.readFileSync(flag("--routing", DEFAULT_ROUTING)!, "utf-8"));
    // routing 里是 user_id；解析成各自最新登录的 bot_id
    for (const who of [r.news, r.tools].filter(Boolean)) {
      const bot = resolveLatestBot(who)?.accountId ?? who;
      ids.push(bot);
    }
  } catch {
    /* fall through */
  }
}
ids = [...new Set(ids)];
if (!ids.length) {
  console.error("✗ 没有要保活的号。用 --account <bot_id> 指定，或确保 routing.json 有 news/tools。");
  process.exit(1);
}

const accounts = listAccounts();
const SESSION_EXPIRED = -14;
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const tm = setTimeout(r, ms);
    ac.signal.addEventListener("abort", () => (clearTimeout(tm), r()), { once: true });
  });

/** 单个号的保活长轮询循环。 */
async function keep(accountId: string) {
  const acct = accounts.find((a) => a.accountId === accountId);
  if (!acct) {
    console.error(`[keepalive] 跳过未登录的号 ${accountId}`);
    return;
  }
  const baseUrl = acct.baseUrl || DEFAULT_BASE_URL;
  const token = acct.botToken;
  loadContextTokens(accountId);
  let buf = readBuf(accountId);
  let timeout = 35_000;
  let fails = 0;
  console.log(`[keepalive] 保活 ${accountId}`);
  while (!ac.signal.aborted) {
    try {
      const started = Date.now();
      const resp: any = await getUpdates({ baseUrl, token, get_updates_buf: buf, timeoutMs: timeout });
      if (resp.longpolling_timeout_ms > 0) timeout = resp.longpolling_timeout_ms;
      if ((resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0)) {
        if (resp.errcode === SESSION_EXPIRED || resp.ret === SESSION_EXPIRED) {
          console.error(`[keepalive] ${accountId} 会话过期，需重新 opennote login。暂停 5 分钟。`);
          await sleep(5 * 60_000);
          continue;
        }
        fails++;
        await sleep(fails >= 5 ? 30_000 : 2_000);
        if (fails >= 5) fails = 0;
        continue;
      }
      fails = 0;
      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        writeBuf(accountId, buf);
      }
      // 缓存 context_token（推送要用），消息本身丢弃。
      for (const msg of resp.msgs ?? []) {
        const inb = parseInbound(msg);
        if (inb.contextToken && inb.from) setContextToken(accountId, inb.from, inb.contextToken);
      }
      // 连续长轮询（≈每 35s 一次）保活；仅当服务端秒回空结果时轻节流防空转。
      if ((resp.msgs?.length ?? 0) === 0 && Date.now() - started < 2_000) await sleep(1_500);
    } catch (e: any) {
      if (ac.signal.aborted) break;
      fails++;
      console.error(`[keepalive] ${accountId} 异常: ${e?.message || e}`);
      await sleep(fails >= 5 ? 30_000 : 2_000);
      if (fails >= 5) fails = 0;
    }
  }
  console.log(`[keepalive] ${accountId} 停止`);
}

console.log(`[keepalive] 保活 ${ids.length} 个推送号：${ids.join(", ")}`);
Promise.all(ids.map(keep));
