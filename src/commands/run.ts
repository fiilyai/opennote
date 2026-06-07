/**
 * `opennote run <name>` — 立刻跑一条定时任务，不等时钟。
 *
 * 两个用途：
 *   1. 调任务时手动验：`opennote run ai-radar` 直接看它产出啥，结果打到终端。
 *   2. 交给系统 crontab / launchd 定时调起（serve 没开也能跑）——这条路是「关了机也想跑」
 *      的备选，跟 serve 内置调度器二选一。
 *
 * 微信登录了就顺便把结果推过去（跟定时触发一致）；没登录就只在终端打印。
 */

import { createCronContext } from "../automation/setup.js";
import { loadConfig } from "../config.js";
import { formatCtx } from "../session/compaction.js";
import { closeBrowser } from "../tools/browser.js";
import { firstAccount } from "../weixin/accounts.js";
import { DEFAULT_BASE_URL } from "../weixin/ilink.js";
import { createWeixinPush } from "../weixin/push.js";

interface RunOptions {
  configPath?: string;
}

export async function runTaskOnce(name: string, options: RunOptions = {}): Promise<void> {
  const config = loadConfig(options.configPath);

  const task = config.cron.find((t) => t.name === name);
  if (!task) {
    const names = config.cron.map((t) => t.name);
    console.error(
      names.length
        ? `没有叫「${name}」的任务。可用：${names.join("、")}`
        : "opennote.yaml 里还没有任何 cron 任务。",
    );
    return;
  }

  // 微信登录了就建推送函数，结果会推到 task.to（或白名单第一个人）；没登录就只打印。
  const account = firstAccount();
  const push =
    account && config.weixin.enabled
      ? createWeixinPush(account, account.baseUrl || config.weixin.baseUrl || DEFAULT_BASE_URL)
      : undefined;

  const cron = createCronContext(config, {
    push,
    defaultTo: config.weixin.allowFrom[0],
    log: (m) => console.error(m),
  });

  console.error(`[cron] 手动运行「${name}」…`);
  try {
    const result = await cron.runTask(task);
    console.log(`\n${result.reply || "（无输出）"}\n`);
    const pushNote = result.pushedTo ? `已推送给 ${result.pushedTo}` : "未推送（微信未登录或没配接收人）";
    console.error(`[cron] 完成。${pushNote}。${formatCtx(result.ctx)}`);
  } finally {
    await closeBrowser();
  }
}
