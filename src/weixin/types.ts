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
  /** 媒体类（IMAGE/FILE/VIDEO）MVP 不解析，留作未知。 */
  image_item?: unknown;
  file_item?: unknown;
  video_item?: unknown;
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
