/**
 * 发文本消息：模型回复是 markdown，微信只认纯文本，先转一道，再组 sendMessage 请求。
 * （markdown→纯文本逻辑参考 openclaw-weixin 的 send.ts，stripMarkdown 自己实现极简版。）
 */

import { sendMessage } from "./ilink.js";
import { MessageItemType, MessageState, MessageType, type SendMessageReq } from "./types.js";

/** 极简 markdown 清洗：去掉常见标记，保留文字与换行。 */
function stripMarkdownLite(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "") // 标题井号
    .replace(/^\s{0,3}>\s?/gm, "") // 引用
    .replace(/^\s*[-*+]\s+/gm, "• ") // 无序列表
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // 粗体
    .replace(/(\*|_)(.*?)\1/g, "$2") // 斜体
    .replace(/~~(.*?)~~/g, "$1") // 删除线
    .replace(/`([^`]+)`/g, "$1"); // 行内代码
}

/** 把模型 markdown 回复转成适合微信的纯文本。 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // 代码块：去围栏，留内容
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => code.trim());
  // 图片：整体删掉
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 链接：只留显示文字
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // 表格分隔行删掉，竖线转空格
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_m, inner: string) =>
    inner
      .split("|")
      .map((c) => c.trim())
      .join("  "),
  );
  return stripMarkdownLite(result).trim();
}

let clientSeq = 0;
function generateClientId(): string {
  clientSeq += 1;
  return `opennote-${Date.now()}-${clientSeq}`;
}

/** 发一条纯文本消息给某个用户。 */
export async function sendText(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
  timeoutMs?: number;
}): Promise<void> {
  const text = markdownToPlainText(params.text);
  const body: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: generateClientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
      context_token: params.contextToken,
    },
  };
  await sendMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
    body,
  });
}
