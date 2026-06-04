/**
 * Day 6 回归测试：system prompt 的分段拼装。
 *
 * 跑法：
 *   pnpm tsx scripts/test-day6-prompt.ts
 *
 * 纯单元测试，不跑 LLM、不要 API key——只验证 buildSystemPrompt 把各段拼对了：
 *   1. 默认值：身份/风格/工作区/纪律/skill 路由/skills 菜单/日期 七段齐全且顺序正确
 *   2. identity / persona 可覆盖，且覆盖后「机制段」（工作区等）仍在
 *   3. systemPrompt 逃生舱整块替代正文，但 skills 菜单 + 日期仍自动追加
 *   4. 日期是本地今天、YYYY-MM-DD
 *   5. 防腐烂：prompt 里不准再出现已删/改名的工具（fetch_content / open_path）
 *      —— 这正是 Day 6 修掉的那处腐烂，钉个测试免得回潮。
 */

import { loadConfig, type OpennoteConfig } from "../src/config.js";
import {
  buildSystemPrompt,
  DEFAULT_IDENTITY,
  DEFAULT_PERSONA,
} from "../src/agent/system-prompt.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}`);
  }
}

/** 基于真实配置，按需覆盖 agent 字段，拼出 prompt。 */
function build(base: OpennoteConfig, agent: Partial<OpennoteConfig["agent"]> = {}): string {
  return buildSystemPrompt({ ...base, agent: { ...base.agent, ...agent } });
}

/** 取两个子串的出现位置，断言 a 在 b 之前。 */
function inOrder(text: string, a: string, b: string): boolean {
  const ia = text.indexOf(a);
  const ib = text.indexOf(b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

function main(): void {
  const base = loadConfig();
  console.log(`[test] 基于 ${base.sourceFile ?? "(内置默认)"} 跑\n`);

  // 强制清掉 yaml 里可能存在的覆盖，确保「默认」分支可测
  const clean: OpennoteConfig = {
    ...base,
    agent: { ...base.agent, identity: undefined, persona: undefined, systemPrompt: undefined },
  };

  // --- 1. 默认值：七段齐全 ---
  const def = build(clean);
  check("默认含内置身份", def.includes(DEFAULT_IDENTITY));
  check("默认含风格段", def.includes("## 风格") && def.includes(DEFAULT_PERSONA.split("\n")[0]));
  check("默认 persona 含情绪边界", def.includes("该有情绪时别端着") && def.includes("点到为止"));
  check("默认含工作区约定", def.includes("## 笔记目录"));
  check("默认含动手纪律", def.includes("## 动手纪律"));
  check("默认含 skill 路由", def.includes("## Skill"));
  check("默认含 skills 菜单", def.includes("<available_skills>"));
  check("默认含今天日期", /今天是 \d{4}-\d{2}-\d{2}。/.test(def));

  // --- 段落顺序：身份 → 风格 → 工作区 → 纪律 → skill 路由 → skills 菜单 → 日期 ---
  check("顺序：身份在风格前", inOrder(def, "你是 ", "## 风格"));
  check("顺序：风格在工作区前", inOrder(def, "## 风格", "## 笔记目录"));
  check("顺序：工作区在纪律前", inOrder(def, "## 笔记目录", "## 动手纪律"));
  check("顺序：纪律在 skill 路由前", inOrder(def, "## 动手纪律", "## Skill"));
  check("顺序：skill 路由在 skills 菜单前", inOrder(def, "## Skill", "<available_skills>"));
  check("顺序：日期在最后", inOrder(def, "<available_skills>", "今天是 "));

  // --- 2. identity / persona 可覆盖 ---
  const id = build(clean, { identity: "阿强，一个毒舌但靠谱的笔记管家" });
  check("identity 覆盖生效", id.includes("阿强") && !id.includes(DEFAULT_IDENTITY));
  check("identity 覆盖后机制段仍在", id.includes("## 笔记目录") && id.includes("## Skill"));

  const pe = build(clean, { persona: "- 全程东北话\n- 能省一个字算一个字" });
  check("persona 覆盖生效", pe.includes("东北话") && !pe.includes(DEFAULT_PERSONA));
  check("persona 覆盖后身份仍是默认", pe.includes(DEFAULT_IDENTITY));

  // --- 3. systemPrompt 逃生舱：整块替代正文，skills + 日期仍追加 ---
  const esc = build(clean, { systemPrompt: "你就是个复读机，原样返回。" });
  check("逃生舱替代正文", esc.includes("复读机"));
  check("逃生舱后正文机制段消失", !esc.includes("## 笔记目录") && !esc.includes(DEFAULT_IDENTITY));
  check("逃生舱仍追加 skills 菜单", esc.includes("<available_skills>"));
  check("逃生舱仍追加日期", /今天是 \d{4}-\d{2}-\d{2}。/.test(esc));

  // --- 4. 日期是本地今天 ---
  const localToday = new Date().toLocaleDateString("sv-SE");
  check(`日期是本地今天（${localToday}）`, def.includes(`今天是 ${localToday}。`));

  // --- 5. 防腐烂：不准出现已删/改名的工具 ---
  check("不含已删工具 fetch_content", !def.includes("fetch_content"));
  check("不含已改名工具 open_path", !def.includes("open_path"));

  // --- 6. 体检：system prompt 每轮都进 ctx，定个预算别让它膨胀 ---
  const BUDGET = 4000;
  check(`system prompt 不超预算（<${BUDGET} 字符，当前 ${def.length}）`, def.length < BUDGET);

  console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
  if (failed === 0) {
    console.log("✅ Day 6 system prompt 拼装测试通过");
    process.exit(0);
  } else {
    console.log("❌ Day 6 system prompt 拼装测试失败");
    process.exit(1);
  }
}

main();
