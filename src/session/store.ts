/**
 * 会话存储（Day 7）。按 from（微信用户）隔离对话状态：每个 from 一个 Session，
 * 各自累积 messages、各自压缩、各自恢复。
 *
 * 这是「agent = 共享执行器，session = per-from 数据」的拆分：opennote 还是单 agent
 * （同一套人格 / model / tools），但每个用户的对话历史独立。处理某条消息时把对应 session
 * 的 messages 载入 agent 跑、跑完存回。serve 串行处理消息，载入/存回不会并发打架。
 *
 * 持久化（功能 5 会话恢复）：每个会话存成一个 JSON 文件，serve 重启后按 from 懒加载，
 * 用户接着上次聊。压缩后的历史也照存，所以恢复回来的是已压缩状态，不会重新膨胀。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Session {
  /** 会话归属的 from（ilink_user_id）。 */
  from: string;
  /** 该用户的对话历史（压缩后也存这里）。 */
  messages: AgentMessage[];
  /** 最近活动时间（毫秒）。 */
  updatedAt: number;
}

const DEFAULT_DIR = join(homedir(), ".opennote", "sessions");

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly dir: string;

  constructor(dir: string = DEFAULT_DIR) {
    this.dir = dir;
  }

  /** 取某个 from 的会话：内存有就用内存，否则从磁盘恢复，再没有就新建空会话。 */
  get(from: string): Session {
    let session = this.sessions.get(from);
    if (!session) {
      session = this.load(from) ?? { from, messages: [], updatedAt: Date.now() };
      this.sessions.set(from, session);
    }
    return session;
  }

  /** 持久化一个会话到磁盘（serve 重启后能 get 回来）。 */
  save(session: Session): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(session.from), JSON.stringify(session), "utf8");
  }

  private load(from: string): Session | undefined {
    const file = this.fileFor(from);
    if (!existsSync(file)) return undefined;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Session>;
      return {
        from,
        messages: data.messages ?? [],
        updatedAt: data.updatedAt ?? Date.now(),
      };
    } catch {
      // 文件损坏就当没有，开个新会话，别让坏文件挡住整个 serve。
      return undefined;
    }
  }

  /** from 含 @ 等字符，文件名做安全化 + 短 hash 防不同 from 撞名。 */
  private fileFor(from: string): string {
    const safe = from.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
    const hash = crypto.createHash("sha256").update(from).digest("hex").slice(0, 8);
    return join(this.dir, `${safe}.${hash}.json`);
  }
}
