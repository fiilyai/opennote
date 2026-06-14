/**
 * Claude bridge 模式：默认所有消息走 opennote 自带 agent；用户发 /claude 切到「跟 headless
 * Claude Code 对话」模式（在指定 cwd 跑 `claude -p`，带命名多会话），/opennote 或 /exit 切回。
 *
 * monitor 在每条消息上先调 handle()：
 *   - 返回 string → 这条已被 Claude 模式处理（或是模式/会话命令），monitor 直接回复、不喂 opennote agent。
 *   - 返回 null   → 用户在 opennote 模式且不是 /claude 命令，monitor 照常走 opennote agent。
 *
 * Claude 自管会话上下文（--session-id 建 / --resume 续），本模块只存「名字→session id」+ 每人模式。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

type Mode = "opennote" | "claude";
interface Sess {
  id: string;
  started: boolean;
  cwd: string;
  createdAt: number;
}
interface UserState {
  mode: Mode;
  active: string;
  sessions: Record<string, Sess>;
}

export interface ClaudeBridgeOpts {
  /** Claude 跑在哪个目录（默认 auto-skill 仓库，带出片流水线/技能）。 */
  cwd?: string;
  /** 权限模式（默认 bypassPermissions：无提示执行任何工具）。 */
  permissionMode?: string;
  model?: string;
  maxRunMs?: number;
}

export class ClaudeBridge {
  private cwd: string;
  private permissionMode: string;
  private model?: string;
  private maxRunMs: number;
  private storePath: string;
  private store: Record<string, UserState> = {};

  constructor(opts: ClaudeBridgeOpts = {}) {
    this.cwd = path.resolve(opts.cwd ?? "/Users/avlin/workspace/25videos/auto-skill");
    this.permissionMode = opts.permissionMode ?? "bypassPermissions";
    this.model = opts.model;
    this.maxRunMs = opts.maxRunMs ?? 20 * 60_000;
    const dir = path.join(homedir(), ".opennote", "bridge");
    fs.mkdirSync(dir, { recursive: true });
    this.storePath = path.join(dir, "state.json");
    try {
      this.store = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
    } catch {
      /* fresh */
    }
  }

  private save() {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
  }
  private newSess(cwd = this.cwd): Sess {
    return { id: randomUUID(), started: false, cwd, createdAt: Date.now() };
  }
  private us(from: string): UserState {
    if (!this.store[from]) this.store[from] = { mode: "opennote", active: "默认", sessions: { 默认: this.newSess() } };
    return this.store[from];
  }

  /** 取当前活动会话（缺失则补建，保证非空）。 */
  private cur(u: UserState): Sess {
    let s = u.sessions[u.active];
    if (!s) {
      s = this.newSess();
      u.sessions[u.active] = s;
    }
    return s;
  }

  /** 当前是否 Claude 模式（monitor 可用来决定进度提示文案等）。 */
  isClaude(from: string): boolean {
    return this.store[from]?.mode === "claude";
  }

  private help(): string {
    return [
      "【Claude 模式】命令：",
      "/opennote 或 /exit       切回 opennote",
      "/sessions               列出会话",
      "/new <名> | /use <名>    新建 / 切换会话",
      "/reset                  重置当前会话",
      "/cwd <路径>             设工作目录",
      "/id | /attach <id>       看/接 claude session id",
      "其它消息 = 交给当前会话的 Claude。",
    ].join("\n");
  }

  /** 处理一条消息。返回 string=已处理；null=交给 opennote agent。onProgress 用于长任务进度。 */
  async handle(from: string, body: string, onProgress?: (m: string) => void): Promise<string | null> {
    const u = this.us(from);
    const t = body.trim();

    // 模式切换（任何模式下都拦截）
    if (t === "/claude") {
      u.mode = "claude";
      this.save();
      return `🤖 已切到 Claude 模式（会话「${u.active}」，cwd ${this.cur(u).cwd}）。/opennote 切回。`;
    }
    if (t === "/opennote" || t === "/exit") {
      const was = u.mode;
      u.mode = "opennote";
      this.save();
      return was === "claude" ? "↩️ 已切回 opennote。" : "（当前就是 opennote 模式）";
    }

    // opennote 模式且非切换命令 → 不处理，交给 opennote agent
    if (u.mode !== "claude") return null;

    // ---- 以下都是 Claude 模式 ----
    let m: RegExpMatchArray | null;
    if (t === "/help" || t === "/?") return this.help();
    if (["/sessions", "/ls", "会话列表"].includes(t)) {
      return (
        "Claude 会话：\n" +
        Object.keys(u.sessions).map((n) => `${n === u.active ? "▸" : "  "} ${n}`).join("\n") +
        `\ncwd：${this.cur(u).cwd}`
      );
    }
    if ((m = t.match(/^\/(?:new|新会话)\s+(.+)$/i))) {
      const name = (m[1] ?? "").trim();
      u.sessions[name] = this.newSess(this.cur(u).cwd);
      u.active = name;
      this.save();
      return `🆕 新建并切到会话「${name}」`;
    }
    if ((m = t.match(/^\/(?:use|switch|切换)\s+(.+)$/i))) {
      const name = (m[1] ?? "").trim();
      if (!u.sessions[name]) return `没有会话「${name}」。/new ${name} 新建。`;
      u.active = name;
      this.save();
      return `✅ 切到会话「${name}」`;
    }
    if (["/reset", "/clear", "重置"].includes(t)) {
      u.sessions[u.active] = this.newSess(this.cur(u).cwd);
      this.save();
      return `🧹 会话「${u.active}」已重置`;
    }
    if ((m = t.match(/^\/cwd\s+(.+)$/))) {
      const s = this.cur(u);
      s.cwd = path.resolve((m[1] ?? "").trim());
      this.save();
      return `📂 工作目录设为 ${s.cwd}`;
    }
    if (t === "/id") {
      const s = this.cur(u);
      return `会话「${u.active}」session id：\n${s.id}\n（终端 claude --resume ${s.id} 可接着聊）`;
    }
    if ((m = t.match(/^\/attach\s+([0-9a-fA-F-]{8,})$/))) {
      const id = (m[1] ?? "").trim();
      u.sessions[u.active] = { id, started: true, cwd: this.cur(u).cwd, createdAt: Date.now() };
      this.save();
      return `🔗 会话「${u.active}」已接到 session ${id}`;
    }

    // 普通消息 → 跑 claude
    const sess = this.cur(u);
    onProgress?.(`🟡「${u.active}」处理中…`);
    const out = await this.runClaude(t, sess);
    this.save();
    return `「${u.active}」\n${out}`;
  }

  private runClaude(prompt: string, sess: Sess): Promise<string> {
    return new Promise((resolve) => {
      const args = ["-p", prompt, "--output-format", "json"];
      args.push(sess.started ? "--resume" : "--session-id", sess.id);
      if (this.model) args.push("--model", this.model);
      if (this.permissionMode) args.push("--permission-mode", this.permissionMode);
      const child = spawn("claude", args, { cwd: sess.cwd, env: process.env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const killer = setTimeout(() => child.kill("SIGKILL"), this.maxRunMs);
      child.on("close", (code) => {
        clearTimeout(killer);
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
          resolve(parsed.result || "(无输出)");
        } else {
          resolve(`⚠️ Claude 运行异常 (code ${code})：\n${(err || txt || "无输出").slice(0, 500)}`);
        }
      });
      child.on("error", (e) => {
        clearTimeout(killer);
        resolve(`⚠️ 无法启动 claude：${e.message}`);
      });
    });
  }
}
