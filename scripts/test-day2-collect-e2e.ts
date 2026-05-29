/**
 * Day 2 端到端：collect-content skill 的 LLM Wiki ingest。
 *
 * 跑法：pnpm tsx scripts/test-day2-collect-e2e.ts
 *
 * 丢一个链接，期望 agent：
 *   1. 命中 collect-content（catalog 里有）→ read SKILL.md
 *   2. fetch_content 抓正文
 *   3. write 到 raw/、wiki/summaries/，并抽概念到 wiki/concepts/ 或 entities/
 *   4. 维护 wiki/index.md
 * 用独立临时笔记目录隔离，事后打印生成的目录树。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createOpennoteAgent } from "../src/agent/create.js";

const TEST_URL = "https://mp.weixin.qq.com/s/m1VoHiX_LPR67oWcZA06PQ";
const NOTES = "/tmp/opennote-wiki-test";

function tree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const isDir = statSync(p).isDirectory();
    out.push(`${prefix}${name}${isDir ? "/" : ` (${statSync(p).size}B)`}`);
    if (isDir) out.push(...tree(p, prefix + "  "));
  }
  return out;
}

async function main() {
  const killer = setTimeout(() => { console.error("\n[self-timeout 360s]"); dump(); process.exit(99); }, 360_000);

  if (existsSync(NOTES)) rmSync(NOTES, { recursive: true, force: true });
  const config = await loadConfig();
  config.paths.notes = NOTES;
  console.log(`[test] model=${config.agent.model} notes=${NOTES}`);

  const agent = createOpennoteAgent(config);
  const writes: string[] = [];
  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      const a = e.args as Record<string, unknown>;
      const arg = String(a.path ?? a.url ?? a.target ?? "");
      console.log(`>>> ${e.toolName} ${arg.slice(0, 80)}`);
      if (e.toolName === "write") writes.push(String(a.path ?? ""));
    }
  });

  await agent.prompt(`帮我收藏一下这个链接，整理进知识库：${TEST_URL}`);
  clearTimeout(killer);
  dump();
  process.exit(0);
}

function dump() {
  console.log(`\n===== ${NOTES} 目录树 =====`);
  for (const l of tree(NOTES)) console.log(l);
  const sumDir = path.join(NOTES, "wiki", "summaries");
  if (existsSync(sumDir)) {
    const f = readdirSync(sumDir)[0];
    if (f) {
      console.log(`\n===== 摘要页样本 ${f} =====`);
      console.log(readFileSync(path.join(sumDir, f), "utf-8").slice(0, 900));
    }
  }
}

main().catch((err) => { console.error("[test] error:", err); process.exit(1); });
