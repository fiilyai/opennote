/**
 * 主动推送一条消息给某个微信用户（Day 8 给定时任务用）。
 *
 * 跟普通回复的唯一区别：这不是在回某条入站消息，而是 agent「自己想发」。iLink 发消息
 * 要带 context_token（见 docs §1.6：缺了服务端可能投递不到正确会话），我们用持久化缓存的
 * 「该用户最近一条入站消息的 token」。
 *
 * ⚠️ 约束：context_token 来自最近一次互动。用户太久没跟 bot 说过话，token 可能过期、
 * 主动推送投递不到——这是 iLink 协议层的限制，不是 bug。实践上日报这类主动消息，发给
 * 「平时就在跟 bot 互动的自己」最稳。
 */

import { getContextToken, loadContextTokens, type AccountRecord } from "./accounts.js";
import { sendText } from "./send.js";

export type Push = (to: string, text: string) => Promise<void>;

/**
 * 基于一个已登录账户造一个 push 函数。会先把持久化的 context_token 载入内存
 * （一次性 CLI 进程里没人调用 loadContextTokens，这里补上）。
 */
export function createWeixinPush(account: AccountRecord, baseUrl: string): Push {
  loadContextTokens(account.accountId);
  return async (to: string, text: string) => {
    await sendText({
      baseUrl,
      token: account.botToken,
      to,
      text,
      contextToken: getContextToken(account.accountId, to),
    });
  };
}
