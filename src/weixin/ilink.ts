/**
 * 微信 iLink 业务 API 客户端（移植自 openclaw-weixin 的 api/api.ts，剥掉 openclaw 的
 * logger/redact/routeTag 依赖）。只放 MVP 用到的：getUpdates（长轮询）+ sendMessage。
 *
 * 全部 HTTP + JSON，纯 Node global fetch（Node 20+）。
 */

import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendMessageReq,
} from "./types.js";

/** iLink 服务默认地址。 */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** 媒体 CDN 默认地址（仅当 getuploadurl 没回 upload_full_url 时用来拼上传 URL）。 */
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** 长轮询默认超时；普通请求超时。 */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

const CHANNEL_VERSION = "opennote";

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64。 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string | undefined): Record<string, string> {
  // 不手动设 Content-Length —— fetch 会按 body 自动算；它还是 fetch 的 forbidden header。
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

/** 由我们自己的超时定时器触发的 abort，区别于真正的网络错误。 */
export class FetchTimeoutError extends Error {}

/** 通用 POST JSON + 超时/abort。成功返回原始文本，失败抛错。 */
async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(params.token),
      body: params.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    // 我们的定时器触发的 abort = 超时（长轮询正常现象）。undici 可能把 abort
    // 包成 TypeError: fetch failed（cause 才是 AbortError），所以靠 timedOut 标志判断最稳。
    if (timedOut) throw new FetchTimeoutError(`${params.label} 客户端超时（${params.timeoutMs}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

/**
 * 长轮询拉新消息。客户端超时是正常的（服务端 hold 住请求），当成"本轮无消息"返回
 * ret=0 空响应，调用方拿同一个游标重试即可。
 */
export async function getUpdates(
  opts: WeixinApiOptions & { get_updates_buf?: string },
): Promise<GetUpdatesResp> {
  const timeout = opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const text = await apiFetch({
      baseUrl: opts.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: opts.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: opts.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(text) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      // 长轮询客户端超时 = 本轮无消息，原样返回游标让调用方重试（不算失败）
      return { ret: 0, msgs: [], get_updates_buf: opts.get_updates_buf };
    }
    throw err;
  }
}

/** 下发一条消息。 */
export async function sendMessage(
  opts: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiFetch({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...opts.body, base_info: buildBaseInfo() }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

/** 取媒体上传的预签名 URL（见 docs §1.8）。媒体上传走 CDN，发媒体消息前先调它。 */
export async function getUploadUrl(
  opts: WeixinApiOptions & GetUploadUrlReq,
): Promise<GetUploadUrlResp> {
  const text = await apiFetch({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: opts.filekey,
      media_type: opts.media_type,
      to_user_id: opts.to_user_id,
      rawsize: opts.rawsize,
      rawfilemd5: opts.rawfilemd5,
      filesize: opts.filesize,
      no_need_thumb: opts.no_need_thumb,
      aeskey: opts.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  return JSON.parse(text) as GetUploadUrlResp;
}
