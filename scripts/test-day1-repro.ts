/**
 * 复现 Danny 报的 bug：LLM 调了 browser（Day 4 前叫 fetch_content）但没 chain 调 write，
 * 还谎称"已存入"。
 *
 * 跑法：pnpm tsx scripts/test-day1-repro.ts
 */

import { loadConfig } from "../src/config.js";
import { createOpennoteAgent } from "../src/agent/create.js";

const URL = "https://mp.weixin.qq.com/s/Brbvd14uuRokWMxtDQfPpQ";

async function main() {
  const config = await loadConfig();
  const agent = createOpennoteAgent(config);

  const calls: { tool: string; argsPreview: string }[] = [];

  agent.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        calls.push({
          tool: event.toolName,
          argsPreview: JSON.stringify(event.args).slice(0, 120),
        });
        console.log(
          `\n[event] tool_execution_start: ${event.toolName} args=${JSON.stringify(event.args).slice(0, 120)}`,
        );
        break;
      case "tool_execution_end":
        console.log(`[event] tool_execution_end: ${event.toolName}`);
        break;
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner?.type === "text_delta") {
          process.stdout.write(inner.delta);
        }
        break;
      }
      case "agent_end":
        console.log(`\n[event] agent_end`);
        break;
    }
  });

  const prompt = `帮我抓取一下 ${URL}，并整理存起来`;
  console.log(`[test] prompt: ${prompt}\n`);

  await agent.prompt(prompt);

  console.log(`\n========== 调用清单 ==========`);
  for (const c of calls) {
    console.log(`  · ${c.tool} ${c.argsPreview}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
