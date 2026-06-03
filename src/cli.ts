/**
 * opennote CLI entry。
 *
 * 用 commander 解析子命令。Day 0 只有 chat（默认）+ 全局 flag。
 * 后续 Day 5 加 serve/login，Day 8 加 run/tidy。
 */

import { Command } from "commander";
import { runChat } from "./commands/chat.js";
import { runLogin } from "./commands/login.js";
import { runServe } from "./commands/serve.js";

const VERSION = "0.0.1";

export async function run(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("opennote")
    .description("用微信收链接、本地织笔记、专题输出的 AI agent")
    .version(VERSION, "-v, --version", "显示版本号");

  program
    .command("chat", { isDefault: true })
    .description("进入对话模式 (默认)")
    .option("-c, --config <path>", "指定 opennote.yaml 路径")
    .action(async (options: { config?: string }) => {
      await runChat({ configPath: options.config });
    });

  program
    .command("login")
    .description("微信扫码登录（存 token 到 ~/.opennote/weixin/）")
    .option("-c, --config <path>", "指定 opennote.yaml 路径")
    .action(async (options: { config?: string }) => {
      await runLogin({ configPath: options.config });
    });

  program
    .command("serve")
    .description("起微信长轮询，把消息驱动到 agent（需先 login + 配 allowFrom）")
    .option("-c, --config <path>", "指定 opennote.yaml 路径")
    .action(async (options: { config?: string }) => {
      await runServe({ configPath: options.config });
    });

  // 后续 Day 8 加：
  //   program.command("run <prompt>") →  单次执行
  //   program.command("tidy")  →  cron 整理

  await program.parseAsync(argv);
}
