#!/usr/bin/env tsx
/**
 * WeChat (iLink) ↔ headless Claude Code 桥。
 *
 * 你在微信发消息 → 桥用 headless `claude -p` 在指定目录跑一轮 → 回复发回微信。
 * 支持「命名多会话」：在微信里切换不同 session（各自独立的 claude 会话/上下文）。
 *
 * 复用 opennote 的 iLink 收发原语（getUpdates / parseInbound / sendText / accounts）。
 * Claude 自己管会话上下文（--session-id 创建 / --resume 续聊），桥只维护「名字→session id」。
 *
 * 用法：
 *   npx tsx bin/bridge.ts [--account <bot_id>] [--cwd <dir>] [--model <m>]
 *                         [--permission-mode <mode>] [--allow <ilink_user_id> ...]
 *   - --cwd 默认 auto-skill 仓库（这样 Claude 带着出片流水线/技能）
 *   - --permission-mode 默认 acceptEdits；要让它能跑 render 等命令用 bypassPermissions
 *   - allowFrom 默认 = 扫码登录者(account.userId)。不在白名单的一律拒绝。
 *
 * 微信里的会话命令（也可用中文，需带「会话」二字以免误判）：
 *   /sessions | 会话列表        列出所有会话（▸ = 当前）
 *   /new <名> | 新会话 <名>      新建并切到该会话
 *   /use <名> | 切换会话 <名>    切到已有会话
 *   /reset                      重置当前会话（重开一段上下文）
 *   /cwd <路径>                 设当前会话的工作目录
 *   /whoami                     看你的 ilink id / 当前会话 / cwd
 *   /help                       命令帮助
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { DEFAULT_BASE_URL, getUpdates } from "../src/weixin/ilink.js";
import { parseInbound } from "../src/weixin/inbound.js";
import { sendText } from "../src/weixin/send.js";
import {
  firstAccount,
  listAccounts,
  readBuf,
  writeBuf,
  loadContextTokens,
  getContextToken,
  setContextToken,
} from "../src/weixin/accounts.js";

// ---------------- args ----------------
const argv = process.argv.slice(2);
const flag = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const accountIdArg = flag("--account");
const DEFAULT_CWD = "/Users/avlin/workspace/25videos/auto-skill";
const defaultCwd = path.resolve(flag("--cwd", DEFAULT_CWD)!);
const model = flag("--model");
// 默认开到最大（用户自负其责）：headless claude 可无提示执行任何工具（含 Bash/render）。
const permissionMode = flag("--permission-mode", "bypassPermissions")!;
const extraAllow: string[] = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--allow") extraAllow.push(argv[i + 1]!);
const MAX_RUN_MS = Number(flag("--max-run-ms", String(20 * 60_000)));
const MAX_REPLY = 3800;

// ---------------- account ----------------
const acct = accountIdArg
  ? listAccounts().find((a) => a.accountId === accountIdArg)
  : firstAccount();
if (!acct) {
  console.error("✗ 没有已登录的微信账户。先在 opennote 里 login（扫码）。");
  process.exit(1);
}
const baseUrl = acct.baseUrl || DEFAULT_BASE_URL;
const token = acct.botToken;
const accountId = acct.accountId;
const allowFrom = [...new Set([...(acct.userId ? [acct.userId] : []), ...extraAllow])];

// ---------------- session store ----------------
interface Sess {
  id: string;
  started: boolean;
  cwd: string;
  createdAt: number;
}
interface UserState {
  active: string;
  sessions: Record<string, Sess>;
}
const storeDir = path.join(homedir(), ".opennote", "bridge");
fs.mkdirSync(storeDir, { recursive: true });
const storePath = path.join(storeDir, `${accountId.replace(/[^\w.@-]/g, "_")}.sessions.json`);
let store: Record<string, UserState> = {};
try {
  store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
} catch {
  /* fresh */
}
const save = () => fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
const newSess = (cwd = defaultCwd): Sess => ({
  id: randomUUID(),
  started: false,
  cwd,
  createdAt: Date.now(),
});
function userState(from: string): UserState {
  if (!store[from]) store[from] = { active: "默认", sessions: { 默认: newSess() } };
  return store[from];
}

// ---------------- claude runner ----------------
function runClaude(prompt: string, sess: Sess): Promise<{ reply: string; error: boolean }> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json"];
    args.push(sess.started ? "--resume" : "--session-id", sess.id);
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    const child = spawn("claude", args, { cwd: sess.cwd, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), MAX_RUN_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      // result JSON 是最后一行（或整体）；容错解析
      let parsed: any = null;
      const txt = out.trim();
      try {
        parsed = JSON.parse(txt);
      } catch {
        const last = txt.split("\n").filter(Boolean).pop() || "";
        try {
          parsed = JSON.parse(last);
        } catch {
          /* give up */
        }
      }
      if (parsed && typeof parsed.result === "string") {
        sess.started = true;
        save();
        resolve({ reply: parsed.result || "(无输出)", error: !!parsed.is_error });
      } else {
        resolve({
          reply: `⚠️ Claude 运行异常 (code ${code})：\n${(err || txt || "无输出").slice(0, 500)}`,
          error: true,
        });
      }
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ reply: `⚠️ 无法启动 claude：${e.message}`, error: true });
    });
  });
}

// ---------------- commands ----------------
function helpText(): string {
  return [
    "可用命令：",
    "/sessions | 会话列表      列出会话（▸=当前）",
    "/new <名> | 新会话 <名>    新建并切换",
    "/use <名> | 切换会话 <名>  切到已有会话",
    "/reset                    重置当前会话",
    "/cwd <路径>               设当前会话工作目录",
    "/id                        看当前会话的 claude session id",
    "/attach <session-id>       把当前会话接到一个已存在的 claude 会话（续其上下文）",
    "/whoami                   看你的 id / 当前会话 / cwd",
    "其它消息 = 直接交给当前会话的 Claude 处理。",
  ].join("\n");
}
/** 返回要回复的字符串；返回 null 表示不是命令、应交给 Claude。 */
function handleCommand(from: string, body: string): string | null {
  const us = userState(from);
  const t = body.trim();
  let m: RegExpMatchArray | null;

  if (t === "/help" || t === "/?" || t === "帮助") return helpText();
  if (t === "/whoami") {
    const s = us.sessions[us.active];
    return `你的 id：${from}\n当前会话：${us.active}\ncwd：${s.cwd}\npermission：${permissionMode}`;
  }
  if (["/sessions", "/ls", "会话列表", "列出会话", "会话"].includes(t)) {
    const names = Object.keys(us.sessions);
    return (
      "会话列表：\n" +
      names.map((n) => `${n === us.active ? "▸" : "  "} ${n}`).join("\n") +
      `\n\ncwd：${us.sessions[us.active].cwd}`
    );
  }
  if (
    (m = t.match(/^\/(?:new|新会话|新建)\s+(.+)$/i)) ||
    (m = t.match(/^新(?:开|建)(?:会话)?\s+(.+)$/))
  ) {
    const name = m[1].trim();
    us.sessions[name] = newSess(us.sessions[us.active]?.cwd);
    us.active = name;
    save();
    return `🆕 已新建并切换到会话「${name}」（全新上下文）`;
  }
  if (
    (m = t.match(/^\/(?:use|switch)\s+(.+)$/i)) ||
    (m = t.match(/^(?:切换|切到|用|使用)\s*会话\s*[:：]?\s*(.+)$/))
  ) {
    const name = m[1].trim();
    if (!us.sessions[name]) return `没有会话「${name}」。/new ${name} 新建，或 /sessions 看列表。`;
    us.active = name;
    save();
    return `✅ 已切到会话「${name}」`;
  }
  if (["/reset", "/clear", "重置", "清空当前会话"].includes(t)) {
    us.sessions[us.active] = newSess(us.sessions[us.active].cwd);
    save();
    return `🧹 会话「${us.active}」已重置（重开一段上下文）`;
  }
  if ((m = t.match(/^\/cwd\s+(.+)$/))) {
    us.sessions[us.active].cwd = path.resolve(m[1].trim());
    save();
    return `📂 会话「${us.active}」工作目录设为 ${us.sessions[us.active].cwd}`;
  }
  if (t === "/id") {
    const s = us.sessions[us.active];
    return `会话「${us.active}」的 claude session id：\n${s.id}\n（终端里 claude --resume ${s.id} 可接着这段聊）`;
  }
  if ((m = t.match(/^\/attach\s+([0-9a-fA-F-]{8,})$/))) {
    const id = m[1].trim();
    us.sessions[us.active] = { id, started: true, cwd: us.sessions[us.active].cwd, createdAt: Date.now() };
    save();
    return `🔗 会话「${us.active}」已接到 session ${id}\n下条消息会 --resume 它的上下文（注意别和终端同时驱动同一会话）`;
  }
  return null;
}

// ---------------- main loop ----------------
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const tm = setTimeout(r, ms);
    ac.signal.addEventListener("abort", () => (clearTimeout(tm), r()), { once: true });
  });

const reply = (to: string, text: string) =>
  sendText({
    baseUrl,
    token,
    to,
    text: text.length > MAX_REPLY ? text.slice(0, MAX_REPLY) + "\n…（已截断）" : text,
    contextToken: getContextToken(accountId, to),
  }).catch((e) => console.error(`回复失败 to=${to}: ${e?.message || e}`));

async function main() {
  loadContextTokens(accountId);
  let buf = readBuf(accountId);
  let timeout = 35_000;
  console.log(`[bridge] account=${accountId} cwd=${defaultCwd} perm=${permissionMode}`);
  console.log(
    allowFrom.length
      ? `[bridge] 白名单：${allowFrom.join(", ")}`
      : `[bridge] ⚠️ 白名单为空，将拒绝所有人。给 bot 发条消息看日志里的 from，再用 --allow <id> 重启。`,
  );

  while (!ac.signal.aborted) {
    try {
      const resp: any = await getUpdates({ baseUrl, token, get_updates_buf: buf, timeoutMs: timeout });
      if (resp.longpolling_timeout_ms > 0) timeout = resp.longpolling_timeout_ms;
      const failed = (resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0);
      if (failed) {
        console.error(`[bridge] getUpdates ret=${resp.ret} errcode=${resp.errcode}`);
        await sleep(resp.errcode === -14 ? 5 * 60_000 : 2_000);
        continue;
      }
      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        writeBuf(accountId, buf);
      }
      for (const msg of resp.msgs ?? []) {
        if (ac.signal.aborted) break;
        const inb = parseInbound(msg);
        if (inb.contextToken && inb.from) setContextToken(accountId, inb.from, inb.contextToken);
        if (inb.isGroup || !inb.from || !inb.body) continue;
        if (!allowFrom.includes(inb.from)) {
          console.log(`[bridge] 拒绝非白名单 ${inb.from}: ${inb.body.slice(0, 40)}`);
          continue;
        }
        console.log(`[bridge] ← ${inb.from}: ${inb.body.slice(0, 60)}`);

        const cmd = handleCommand(inb.from, inb.body);
        if (cmd !== null) {
          await reply(inb.from, cmd);
          continue;
        }

        const us = userState(inb.from);
        const sess = us.sessions[us.active];
        await reply(inb.from, `🟡「${us.active}」收到，处理中…`);
        const hb = setInterval(() => reply(inb.from, `⏳「${us.active}」还在跑…`), 120_000);
        const { reply: out } = await runClaude(inb.body, sess);
        clearInterval(hb);
        await reply(inb.from, `「${us.active}」\n${out}`);
        console.log(`[bridge] → ${inb.from}: ${out.slice(0, 60)}`);
      }
    } catch (e: any) {
      if (ac.signal.aborted) break;
      console.error(`[bridge] loop error: ${e?.message || e}`);
      await sleep(2_000);
    }
  }
  console.log("[bridge] 已停止");
}

main();
