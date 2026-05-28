/**
 * Day 1 端到端测试：从 URL 到笔记文件的完整流水线。
 *
 * 跑法：
 *   pnpm tsx scripts/test-day1-e2e.ts
 *
 * 期望：
 *   1. 用户系统 Chrome 弹出窗口
 *   2. fetch_content 被调用，URL 是测试链接
 *   3. write tool 被调用，文件落到 ~/.opennote/notes/ 下
 *   4. 笔记文件实际存在并有内容
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { createOpennoteAgent } from "../src/agent/create.js";

const TEST_URL = "https://mp.weixin.qq.com/s/m1VoHiX_LPR67oWcZA06PQ";
const NOTES_DIR = path.join(homedir(), ".opennote", "notes");

async function main() {
  console.log(`[test] loading config...`);
  const config = await loadConfig();
  console.log(`[test] model=${config.agent.model}`);

  const agent = createOpennoteAgent(config);
  const toolNames = (agent.state.tools ?? []).map((t) => t.name);
  console.log(`[test] tools registered: ${toolNames.join(", ")}`);

  const callLog: { tool: string; args: unknown }[] = [];

  agent.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        callLog.push({ tool: event.toolName, args: event.args });
        console.log(
          `\n[event] tool_execution_start: ${event.toolName} args=${JSON.stringify(event.args).slice(0, 200)}`,
        );
        break;
      case "tool_execution_end":
        console.log(`[event] tool_execution_end: ${event.toolName} ok`);
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

  // 记录测试前 notes 目录里已有的文件，事后只对比新增
  const filesBefore = existsSync(NOTES_DIR)
    ? new Set(readdirSync(NOTES_DIR))
    : new Set<string>();

  const prompt =
    `请抓取这个链接的内容：${TEST_URL}\n` +
    `然后整理成一篇 markdown 笔记，保存到 today-test.md。`;
  console.log(`\n[test] sending prompt:\n${prompt}\n`);

  await agent.prompt(prompt);

  // 检查文件
  const filesAfter = existsSync(NOTES_DIR) ? readdirSync(NOTES_DIR) : [];
  const newFiles = filesAfter.filter((f) => !filesBefore.has(f));

  console.log(`\n========== 测试结果 ==========`);
  console.log(`tool 调用次数：${callLog.length}`);
  for (const c of callLog) {
    console.log(`  · ${c.tool}`);
  }
  console.log(`\n新增笔记文件：${newFiles.length} 个`);
  for (const f of newFiles) {
    const p = path.join(NOTES_DIR, f);
    const size = statSync(p).size;
    console.log(`  · ${f} (${size} 字节)`);
    if (size > 0 && size < 5000) {
      // 小文件就预览开头
      console.log(`    --- preview ---`);
      console.log(
        readFileSync(p, "utf-8")
          .split("\n")
          .slice(0, 5)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
  }

  const fetched = callLog.some((c) => c.tool === "fetch_content");
  const wrote = callLog.some((c) => c.tool === "write");
  const hasFile = newFiles.length > 0;

  console.log(`\nfetch_content 被调用：${fetched ? "✅" : "❌"}`);
  console.log(`write 被调用：${wrote ? "✅" : "❌"}`);
  console.log(`新笔记文件已生成：${hasFile ? "✅" : "❌"}`);

  if (fetched && wrote && hasFile) {
    console.log(`\n✅ Day 1 端到端测试通过`);
    process.exit(0);
  } else {
    console.log(`\n❌ Day 1 端到端测试失败`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[test] error:`, err);
  process.exit(1);
});
