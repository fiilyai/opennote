/**
 * `opennote serve` — 起微信长轮询，把消息驱动到 agent 再把回复发回去。
 * 常驻前台、无监听端口；Ctrl-C 干净退出。
 */

import { createOpennoteAgent } from "../agent/create.js";
import { makeApiKeyResolver } from "../agent/model.js";
import { closeBrowser } from "../tools/browser.js";
import { loadConfig } from "../config.js";
import { SessionStore } from "../session/store.js";
import type { CompactionDeps } from "../session/compaction.js";
import { createCronContext } from "../automation/setup.js";
import { resolveLatestBot, type AccountRecord } from "../weixin/accounts.js";
import { ClaudeBridge } from "../weixin/claude-bridge.js";
import { DEFAULT_BASE_URL } from "../weixin/ilink.js";
import { runMonitor } from "../weixin/monitor.js";
import { createWeixinPush } from "../weixin/push.js";
import { singleAgentRouter } from "../weixin/router.js";

interface ServeOptions {
  configPath?: string;
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const config = loadConfig(options.configPath);

  if (!config.weixin.enabled) {
    console.error("微信通道未开启。在 opennote.yaml 里设 weixin.enabled: true。");
    return;
  }

  // 安全闸：白名单为空 = 谁都不能驱动 agent（这是把 bash/write 暴露给外部输入，必须卡死）。
  if (config.weixin.allowFrom.length === 0) {
    console.error(
      "⚠️ weixin.allowFrom 为空：没有任何人能驱动 agent。\n" +
        "把你的 ilink_user_id（login 成功时打印过）加进 opennote.yaml 的 weixin.allowFrom 再 serve。",
    );
    return;
  }

  // 按稳定 user_id 解析每个白名单用户【最新登录】的 bot（每次扫码新发 bot_id，自动跟最新）。
  const bots: AccountRecord[] = [];
  const seenBot = new Set<string>();
  for (const user of config.weixin.allowFrom) {
    const rec = resolveLatestBot(user);
    if (rec && !seenBot.has(rec.accountId)) {
      seenBot.add(rec.accountId);
      bots.push(rec);
    }
  }
  if (bots.length === 0) {
    console.error("还没登录微信（allowFrom 里的 user 都没扫码过）。先运行 opennote login。");
    return;
  }

  const agent = createOpennoteAgent(config);
  const primary = bots[0]!;
  const baseUrl = primary.baseUrl || config.weixin.baseUrl || DEFAULT_BASE_URL;

  // 按 from 隔离的会话存储 + 上下文压缩依赖（跟 agent 用同一套 model / key / headers）。
  const sessionStore = new SessionStore();
  const resolveKey = makeApiKeyResolver(config);
  const compaction: CompactionDeps = {
    model: agent.state.model,
    apiKey: resolveKey(agent.state.model.provider) ?? "",
    headers: config.agent.headers,
  };

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n收到退出信号，停止监听...");
    controller.abort();
  });

  // 定时任务（Day 8）：用独立 agent 实例，跟消息通道隔离，不互相踩 state.messages。
  // 推送复用持久化的 context_token；任务没配 to 就默认推给白名单第一个人（一般就是你自己）。
  const push = createWeixinPush(primary, baseUrl);
  const cron = createCronContext(config, {
    sessionStore,
    push,
    defaultTo: config.weixin.allowFrom[0],
  });

  // /claude 模式：默认消息走上面的 opennote agent；发 /claude 切到 headless Claude。
  const claudeBridge = new ClaudeBridge({
    cwd: "/Users/avlin/workspace/25videos/auto-skill",
    permissionMode: "bypassPermissions",
  });

  console.log(
    `[serve] 监听 ${bots.length} 个号(每用户最新)：${bots.map((b) => b.accountId).join(", ")}`,
  );

  // 每个用户的最新 bot 各跑一个 monitor（共用 agent / 会话存储 / claudeBridge）；
  // monitor 自带长轮询=顺带保活（取代独立 keepalive）。调度循环只起一次。
  await Promise.all([
    ...bots.map((b) =>
      runMonitor({
        baseUrl: b.baseUrl || config.weixin.baseUrl || DEFAULT_BASE_URL,
        token: b.botToken,
        accountId: b.accountId,
        allowFrom: config.weixin.allowFrom,
        resolveAgent: singleAgentRouter(agent),
        sessionStore,
        compaction,
        cron: cron.commandDeps,
        claudeBridge,
        abortSignal: controller.signal,
      }),
    ),
    cron.startScheduler(controller.signal),
  ]);

  // 两个循环都停了（SIGINT abort），彻底关掉可能还开着的 Chrome。
  await closeBrowser();
}
