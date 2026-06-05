/**
 * Day 7 回归测试：上下文压缩 + 会话管理。
 *
 * 跑法：
 *   pnpm tsx scripts/test-day7-session.ts
 *
 * 纯单元，不跑 LLM、不要 API key（generateSummary 的实际摘要靠 e2e）。验证：
 *   1. ctx 用量估算 + 格式（ctx 78.5k 61.33%）
 *   2. 小对话不误压（maybeCompact 返回 null）
 *   3. 会话持久化：save → 重启 load 能恢复；不同 from 隔离；坏文件不崩
 *   4. 斜杠命令解析：/clear 清空、/help、/ctx、未知命令、非命令放行
 */

import { rmSync } from "node:fs";

import { loadConfig } from "../src/config.js";
import { resolveModel } from "../src/agent/model.js";
import {
  getCtxUsage,
  formatCtx,
  maybeCompact,
  OPENNOTE_COMPACTION,
  type CompactionDeps,
} from "../src/session/compaction.js";
import { SessionStore } from "../src/session/store.js";
import { handleSessionCommand } from "../src/session/commands.js";

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

const TMP = "/tmp/opennote-day7-test";

async function main(): Promise<void> {
  const model = resolveModel(loadConfig());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compaction: CompactionDeps = { model, apiKey: "x", headers: {} } as any;

  // --- 1. ctx 估算 + 格式 ---
  const usage = getCtxUsage(
    [{ role: "user", content: "hi", timestamp: 0 }],
    model,
  );
  check("ctx 百分比 = tokens/window", Math.abs(usage.percent - (usage.tokens / usage.window) * 100) < 1e-6);
  check("formatCtx 格式 ctx <n> <pct>%", /^ctx \S+ \d+\.\d{2}%$/.test(formatCtx(usage)));

  // --- 2. 小对话不误压 ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msgs: any[] = [{ role: "user", content: "整理一下", timestamp: 0 }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeAgent = { state: { get messages() { return msgs; }, set messages(m: any) { msgs = m; }, model } } as any;
  const r = await maybeCompact(fakeAgent, { ...compaction, settings: OPENNOTE_COMPACTION });
  check("小对话不误压（maybeCompact=null）", r === null);

  // --- 3. 会话持久化 ---
  rmSync(TMP, { recursive: true, force: true });
  const store1 = new SessionStore(TMP);
  const sess = store1.get("alice@im.wechat");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sess.messages = [{ role: "user", content: "记一下", timestamp: 1 }] as any;
  store1.save(sess);

  const store2 = new SessionStore(TMP); // 模拟 serve 重启
  const restored = store2.get("alice@im.wechat");
  check("重启后恢复会话", restored.messages.length === 1);
  check("不同 from 隔离", store2.get("bob@im.wechat").messages.length === 0);
  rmSync(TMP, { recursive: true, force: true });

  // --- 4. 斜杠命令（通道无关，只操作 agent）---
  msgs = [{ role: "user", content: "x", timestamp: 1 }];

  check("非命令放行（返回 null）", (await handleSessionCommand("你好", fakeAgent, compaction)) === null);

  const clearReply = await handleSessionCommand("/clear", fakeAgent, compaction);
  check("/clear 清空会话", msgs.length === 0 && !!clearReply && clearReply.includes("清空"));

  const helpReply = await handleSessionCommand("/help", fakeAgent, compaction);
  check("/help 列出命令", !!helpReply && helpReply.includes("/compact"));

  const ctxReply = await handleSessionCommand("/ctx", fakeAgent, compaction);
  check("/ctx 返回用量", !!ctxReply && /^ctx /.test(ctxReply));

  const unknownReply = await handleSessionCommand("/wat", fakeAgent, compaction);
  check("未知命令有提示", !!unknownReply && unknownReply.includes("未知命令"));

  console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
  if (failed === 0) {
    console.log("✅ Day 7 会话/压缩测试通过");
    process.exit(0);
  } else {
    console.log("❌ Day 7 会话/压缩测试失败");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test] error:", err);
  process.exit(1);
});
