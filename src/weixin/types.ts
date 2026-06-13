/**
 * 微信 iLink 协议结构（移植自 @tencent-weixin/openclaw-weixin 的 api/types.ts）。
 * 协议走 HTTP + JSON，proto 的 bytes 字段在 JSON 里是 base64 字符串。
 * 只保留 MVP（收发文本）用得到的部分，媒体字段从简。
 */

/** 每个请求附带的元信息。 */
export interface BaseInfo {
  channel_version?: string;
}

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export interface TextItem {
  text?: string;
}

export interface VoiceItem {
  /** 语音转文字内容（有就直接用） */
  text?: string;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  voice_item?: VoiceItem;
  /** 媒体类（IMAGE/FILE/VIDEO）：入站不解析，出站发送用下列结构。 */
  image_item?: ImageItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ---- 媒体发送（出站）：CDN + AES-128-ECB，见 docs/weixin-ilink-integration.md §1.8 ----

/** proto: UploadMediaType（getuploadurl 的 media_type）。 */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

/** CDN 媒体引用；aes_key 在 JSON 里是 base64 字符串。 */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0=只加密 fileid，1=打包缩略图/中图等信息。 */
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  /** 原图密文大小（字节）。 */
  mid_size?: number;
}

export interface VideoItem {
  media?: CDNMedia;
  /** 视频密文大小（字节）。 */
  video_size?: number;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  /** 明文字节数（字符串）。 */
  len?: string;
}

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  /** 明文大小。 */
  rawsize?: number;
  /** 明文 MD5（hex）。 */
  rawfilemd5?: string;
  /** 密文大小（AES-128-ECB + PKCS7 后）。 */
  filesize?: number;
  /** 不需要缩略图上传 URL。 */
  no_need_thumb?: boolean;
  /** AES-128 key（hex）。 */
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  /** 完整上传 URL（服务端直接返回则无需客户端拼接）。 */
  upload_full_url?: string;
}

/** proto: WeixinMessage */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 同步游标：存下来下轮带上。 */
  get_updates_buf?: string;
  /** 服务端建议的下轮长轮询超时（ms）。 */
  longpolling_timeout_ms?: number;
}

/** 发消息：包一条 WeixinMessage。 */
export interface SendMessageReq {
  msg?: WeixinMessage;
}
