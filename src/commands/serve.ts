/**
 * `opennote serve` — 起微信长轮询，把消息驱动到 agent 再把回复发回去。
 * 常驻前台、无监听端口；Ctrl-C 干净退出。
 */

import { createOpennoteAgent } from "../agent/create.js";
import { loadConfig } from "../config.js";
import { firstAccount } from "../weixin/accounts.js";
import { DEFAULT_BASE_URL } from "../weixin/ilink.js";
import { runMonitor } from "../weixin/monitor.js";
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

  const account = firstAccount();
  if (!account) {
    console.error("还没登录微信。先运行 opennote login 扫码。");
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

  const agent = createOpennoteAgent(config);
  const baseUrl = account.baseUrl || config.weixin.baseUrl || DEFAULT_BASE_URL;

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n收到退出信号，停止监听...");
    controller.abort();
  });

  await runMonitor({
    baseUrl,
    token: account.botToken,
    accountId: account.accountId,
    allowFrom: config.weixin.allowFrom,
    resolveAgent: singleAgentRouter(agent),
    abortSignal: controller.signal,
  });
}
