/**
 * 微信 iLink 媒体发送（出站）：本地文件 → AES-128-ECB 加密 → CDN 上传 → 发图片/视频/文件消息。
 * 移植自 @tencent-weixin/openclaw-weixin 的 cdn/* + messaging/send-media.ts，字段映射严格对齐。
 *
 * 流程（见 docs/weixin-ilink-integration.md §1.8）：
 *   读文件 → md5(明文) → 随机 16B aeskey → getUploadUrl(密文大小, aeskey hex)
 *   → AES-128-ECB(PKCS7) 加密 → POST 密文到 CDN（octet-stream）→ 响应头 x-encrypted-param
 *   → 组 image_item/video_item/file_item(media.encrypt_query_param + aes_key) → sendMessage
 *
 * ⚠️ aes_key 字段 = base64(aeskey 的 hex 字符串)，跟 getUploadUrl 的 aeskey(hex) 必须一致——
 *    这是协议要求，别"优化"成 base64(raw bytes)，否则对端解不开。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_CDN_BASE_URL,
  getUploadUrl,
  sendMessage,
  type WeixinApiOptions,
} from "./ilink.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  UploadMediaType,
  type CDNMedia,
  type MessageItem,
} from "./types.js";

/** AES-128-ECB 加密（PKCS7 padding，Node 默认）。 */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB + PKCS7 后的密文大小。 */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** 极简 mime 判断（只需区分 video / image / 其它）。 */
function mediaTypeOf(filePath: string): {
  kind: "video" | "image" | "file";
  mediaType: number;
} {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"].includes(ext))
    return { kind: "video", mediaType: UploadMediaType.VIDEO };
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext))
    return { kind: "image", mediaType: UploadMediaType.IMAGE };
  return { kind: "file", mediaType: UploadMediaType.FILE };
}

interface Uploaded {
  filekey: string;
  downloadEncryptedQueryParam: string;
  /** hex 字符串。 */
  aeskeyHex: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

/** 上传一个本地文件到微信 CDN（加密）。 */
async function uploadToCdn(params: {
  filePath: string;
  toUserId: string;
  mediaType: number;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<Uploaded> {
  const { filePath, toUserId, mediaType, opts, cdnBaseUrl } = params;
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");

  const up = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskeyHex,
  });

  const fullUrl = up.upload_full_url?.trim();
  const cdnUrl = fullUrl
    ? fullUrl
    : up.upload_param
      ? `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : undefined;
  if (!cdnUrl) throw new Error("getUploadUrl 没返回上传地址（upload_full_url / upload_param 都为空）");

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  let downloadParam: string | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN 客户端错误 ${res.status}: ${res.headers.get("x-error-message") ?? (await res.text())}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN 服务端错误 ${res.status}: ${res.headers.get("x-error-message") ?? ""}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param");
      break;
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.message.includes("客户端错误")) throw err;
    }
  }
  if (!downloadParam) {
    throw lastErr instanceof Error ? lastErr : new Error("CDN 上传 3 次均失败");
  }

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskeyHex,
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/** CDNMedia：aes_key = base64(hex 字符串)，encrypt_type=1。 */
function cdnMedia(up: Uploaded): CDNMedia {
  return {
    encrypt_query_param: up.downloadEncryptedQueryParam,
    aes_key: Buffer.from(up.aeskeyHex).toString("base64"),
    encrypt_type: 1,
  };
}

function clientId(): string {
  return crypto.randomBytes(12).toString("hex");
}

async function sendOneItem(params: {
  opts: WeixinApiOptions;
  to: string;
  contextToken?: string;
  item: MessageItem;
}): Promise<void> {
  await sendMessage({
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    timeoutMs: params.opts.timeoutMs,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: clientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [params.item],
        context_token: params.contextToken,
      },
    },
  });
}

/**
 * 发一个本地媒体文件给某用户：可选先发一条文本 caption，再单独发媒体条目
 * （每条 item 单独成一条消息，跟 openclaw 一致）。按扩展名路由 video/image/file。
 */
export async function sendMediaFile(params: {
  opts: WeixinApiOptions;
  to: string;
  filePath: string;
  text?: string;
  contextToken?: string;
  cdnBaseUrl?: string;
}): Promise<void> {
  const { opts, to, filePath, text, contextToken } = params;
  const cdnBaseUrl = params.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
  const { kind, mediaType } = mediaTypeOf(filePath);

  if (text && text.trim()) {
    await sendOneItem({
      opts,
      to,
      contextToken,
      item: { type: MessageItemType.TEXT, text_item: { text: text.trim() } },
    });
  }

  const up = await uploadToCdn({ filePath, toUserId: to, mediaType, opts, cdnBaseUrl });
  const media = cdnMedia(up);

  let item: MessageItem;
  if (kind === "video") {
    item = { type: MessageItemType.VIDEO, video_item: { media, video_size: up.fileSizeCiphertext } };
  } else if (kind === "image") {
    item = { type: MessageItemType.IMAGE, image_item: { media, mid_size: up.fileSizeCiphertext } };
  } else {
    item = {
      type: MessageItemType.FILE,
      file_item: { media, file_name: path.basename(filePath), len: String(up.fileSize) },
    };
  }
  await sendOneItem({ opts, to, contextToken, item });
}
