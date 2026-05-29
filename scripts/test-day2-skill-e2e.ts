/**
 * Day 2 端到端测试：skill 的完整渐进式加载链。
 *
 * 跑法：
 *   pnpm tsx scripts/test-day2-skill-e2e.ts
 *
 * 用 ~/.agents/skills/obsidian-markdown 这个标准 skill 当被测对象，期望：
 *   1. skill 出现在 system prompt 的菜单里（catalog）
 *   2. LLM 判断任务匹配，用 read 工具读 obsidian-markdown/SKILL.md（tier 2）
 *   3. 可能进一步 read references/（CALLOUTS.md 等，tier 3，按需）
 *   4. 用 write 把成品写到 ~/.opennote/notes/，正文含 Obsidian 语法
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { createOpennoteAgent } from "../src/agent/create.js";

const NOTES_DIR = path.join(homedir(), ".opennote", "notes");

async function main() {
  const config = await loadConfig();
  console.log(`[test] model=${config.agent.model}`);

  // 这个测试专门验证跨客户端全局 ~/.agents/skills 的 interop（obsidian-markdown 装在那），
  // 而它默认是关的，所以这里显式开启。
  config.globalAgentSkills = true;

  const agent = createOpennoteAgent(config);

  // 确认 catalog 里有 obsidian-markdown
  const sp = (agent.state as { systemPrompt?: string }).systemPrompt ?? "";
  const inCatalog = sp.includes("<name>obsidian-markdown</name>");
  console.log(`[test] obsidian-markdown 在菜单里：${inCatalog ? "✅" : "❌"}`);

  const reads: string[] = [];
  let wrote = false;

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const args = event.args as Record<string, unknown>;
      if (event.toolName === "read") {
        const p = String(args.path ?? args.target ?? "");
        reads.push(p);
        console.log(`[event] read → ${p}`);
      } else if (event.toolName === "write") {
        wrote = true;
        console.log(`[event] write → ${String(args.path ?? "")}`);
      } else {
        console.log(`[event] ${event.toolName}`);
      }
    }
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner?.type === "text_delta") process.stdout.write(inner.delta);
    }
  });

  const filesBefore = existsSync(NOTES_DIR)
    ? new Set(readdirSync(NOTES_DIR))
    : new Set<string>();

  const prompt =
    "请用 Obsidian 格式写一篇关于「番茄工作法」的简短笔记，" +
    "要用到 wikilinks 和 callouts，保存到 obsidian-test.md。";
  console.log(`\n[test] prompt: ${prompt}\n`);

  await agent.prompt(prompt);

  // 结果判定
  const readSkill = reads.some((p) => p.includes("obsidian-markdown") && p.endsWith("SKILL.md"));
  const readRefs = reads.some((p) => p.includes("obsidian-markdown") && p.includes("references"));

  const newFiles = (existsSync(NOTES_DIR) ? readdirSync(NOTES_DIR) : []).filter(
    (f) => !filesBefore.has(f),
  );
  let hasObsidianSyntax = false;
  for (const f of newFiles) {
    const body = readFileSync(path.join(NOTES_DIR, f), "utf-8");
    if (/\[\[.+?\]\]/.test(body) || /^>\s*\[!/m.test(body)) hasObsidianSyntax = true;
  }

  console.log(`\n========== 测试结果 ==========`);
  console.log(`obsidian-markdown 进菜单：${inCatalog ? "✅" : "❌"}`);
  console.log(`read 了 SKILL.md（tier 2）：${readSkill ? "✅" : "❌"}`);
  console.log(`read 了 references（tier 3，可选）：${readRefs ? "✅" : "—"}`);
  console.log(`write 被调用：${wrote ? "✅" : "❌"}`);
  console.log(`成品含 Obsidian 语法（wikilink/callout）：${hasObsidianSyntax ? "✅" : "❌"}`);
  console.log(`新增文件：${newFiles.join(", ") || "(无)"}`);

  const pass = inCatalog && readSkill && wrote && hasObsidianSyntax;
  console.log(pass ? "\n✅ Day 2 skill 端到端测试通过" : "\n❌ Day 2 skill 端到端测试失败");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`[test] error:`, err);
  process.exit(1);
});
