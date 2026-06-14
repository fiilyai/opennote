/**
 * 微信凭证 / 游标 / contextToken 的本地存储，全部落在 ~/.opennote/weixin/accounts/。
 * token 等凭证不进 opennote.yaml、不进 git。
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export interface AccountRecord {
  /** ilink_bot_id，形如 xxx@im.bot，作存储/路由主键。 */
  accountId: string;
  botToken: string;
  /** 登录时服务端可能指定的 baseUrl（覆盖默认）。 */
  baseUrl?: string;
  /** 扫码人的 ilink_user_id（提示加进 allowFrom 用）。 */
  userId?: string;
}

function weixinDir(): string {
  return path.join(homedir(), ".opennote", "weixin", "accounts");
}

/** 文件名安全化（accountId 含 @ 等字符）。 */
function fileSafe(id: string): string {
  return id.replace(/[^\w.@-]/g, "_");
}

function ensureDir(): string {
  const dir = weixinDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- 账户凭证 ----

export function saveAccount(rec: AccountRecord): void {
  const dir = ensureDir();
  fs.writeFileSync(
    path.join(dir, `${fileSafe(rec.accountId)}.json`),
    JSON.stringify(rec, null, 2),
    "utf-8",
  );
}

export function listAccounts(): AccountRecord[] {
  const dir = weixinDir();
  if (!fs.existsSync(dir)) return [];
  const out: AccountRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".context-tokens.json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as AccountRecord);
    } catch {
      // 坏文件忽略
    }
  }
  return out;
}

/** MVP：取第一个登录过的账户。 */
export function firstAccount(): AccountRecord | undefined {
  return listAccounts()[0];
}

/**
 * 按「稳定的 ilink_user_id」取该用户**最新登录**的 bot。
 * 每次扫码 server 都新发 bot_id（旧号媒体上传会过期），但同一微信用户的 user_id 不变；
 * 所以按 userId 选最新的账号文件（mtime 最大）即可永远跟到最新号。
 */
export function resolveLatestBot(userId: string): AccountRecord | undefined {
  const dir = weixinDir();
  if (!fs.existsSync(dir)) return undefined;
  let best: { rec: AccountRecord; mtime: number } | undefined;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".context-tokens.json")) continue;
    const full = path.join(dir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(full, "utf-8")) as AccountRecord;
      if (rec.userId !== userId) continue;
      const mtime = fs.statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { rec, mtime };
    } catch {
      // 坏文件忽略
    }
  }
  return best?.rec;
}

// ---- getUpdates 同步游标（持久化，重启续传）----

function bufPath(accountId: string): string {
  return path.join(weixinDir(), `${fileSafe(accountId)}.get-updates-buf`);
}

export function readBuf(accountId: string): string {
  try {
    return fs.readFileSync(bufPath(accountId), "utf-8");
  } catch {
    return "";
  }
}

export function writeBuf(accountId: string, buf: string): void {
  try {
    ensureDir();
    fs.writeFileSync(bufPath(accountId), buf, "utf-8");
  } catch {
    // 游标写盘失败不致命，下轮重来
  }
}

// ---- contextToken（每用户最近一条入站消息的 token，回显用）----

const ctxStore = new Map<string, string>();
const ctxKey = (accountId: string, userId: string) => `${accountId}:${userId}`;

function ctxFile(accountId: string): string {
  return path.join(weixinDir(), `${fileSafe(accountId)}.context-tokens.json`);
}

export function loadContextTokens(accountId: string): void {
  try {
    const raw = fs.readFileSync(ctxFile(accountId), "utf-8");
    const tokens = JSON.parse(raw) as Record<string, string>;
    for (const [userId, token] of Object.entries(tokens)) {
      if (token) ctxStore.set(ctxKey(accountId, userId), token);
    }
  } catch {
    // 没有就算了
  }
}

function persistContextTokens(accountId: string): void {
  const prefix = `${accountId}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of ctxStore) {
    if (k.startsWith(prefix)) tokens[k.slice(prefix.length)] = v;
  }
  try {
    ensureDir();
    fs.writeFileSync(ctxFile(accountId), JSON.stringify(tokens), "utf-8");
  } catch {
    // 非致命
  }
}

export function setContextToken(accountId: string, userId: string, token: string): void {
  ctxStore.set(ctxKey(accountId, userId), token);
  persistContextTokens(accountId);
}

export function getContextToken(accountId: string, userId: string): string | undefined {
  return ctxStore.get(ctxKey(accountId, userId));
}
