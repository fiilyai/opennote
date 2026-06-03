/**
 * 入站 WeixinMessage → opennote 用的简单结构 { from, body, contextToken }。
 * MVP 只取文本：TEXT item 的文字，语音若自带转写文字也用，引用消息拼成前缀。
 */

import type { MessageItem, WeixinMessage } from "./types.js";
import { MessageItemType } from "./types.js";

export interface InboundMessage {
  /** 发送者 ilink_user_id。 */
  from: string;
  /** 文本正文（链接也是文本）。 */
  body: string;
  /** 回显用的 context_token。 */
  contextToken?: string;
  /** 群消息标记（MVP 跳过群）。 */
  isGroup: boolean;
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    // 语音转文字：有 text 就直接用
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export function parseInbound(msg: WeixinMessage): InboundMessage {
  return {
    from: msg.from_user_id ?? "",
    body: bodyFromItemList(msg.item_list),
    contextToken: msg.context_token,
    isGroup: Boolean(msg.group_id),
  };
}
