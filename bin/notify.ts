#!/usr/bin/env node

/**
 * notify — 给已登录的微信用户主动推一条消息（一次性，非常驻）。文本，或带媒体。
 *
 * 用法：
 *   tsx bin/notify.ts "出片啦：xxx"                       # 纯文本
 *   echo "多行内容" | tsx bin/notify.ts                   # 无文本参数则读 stdin
 *   tsx bin/notify.ts --file out/xxx.mp4 "出片啦"          # 发视频/图片/文件 + 文本 caption
 *   tsx bin/notify.ts --to <ilink_user_id> --file a.jpg    # 指定接收人 + 媒体
 *
 * 依赖 `opennote login` 留下的凭证（~/.opennote/weixin/accounts/）。
 * ⚠️ iLink 主动推送依赖最近一次互动的 context_token；太久没跟 bot 说话可能投递不到
 *    （见 docs/weixin-ilink-integration.md §1.6）。发给「平时就在跟 bot 互动的自己」最稳。
 */

import { firstAccount, getContextToken, loadContextTokens } from "../src/weixin/accounts.js";
import { DEFAULT_BASE_URL } from "../src/weixin/ilink.js";
import { sendMediaFile } from "../src/weixin/media.js";
import { createWeixinPush } from "../src/weixin/push.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const argv = process.argv.slice(2);
let to: string | undefined;
let file: string | undefined;
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (a === "--to") to = argv[++i];
  else if (a === "--file") file = argv[++i];
  else rest.push(a);
}

let text = rest.join(" ").trim();
if (!text && !file) text = (await readStdin()).trim();
if (!text && !file) {
  console.error('usage: notify [--to <id>] [--file <path>] "<message>"   (或用管道传文本)');
  process.exit(1);
}

const account = firstAccount();
if (!account) {
  console.error("微信未登录：没有找到账户凭证（先在 opennote 里 `opennote login`）。");
  process.exit(2);
}

const target = to || account.userId;
if (!target) {
  console.error("没有接收人：账户里没有 userId，请用 --to 指定 ilink_user_id。");
  process.exit(3);
}

const baseUrl = account.baseUrl || DEFAULT_BASE_URL;
try {
  if (file) {
    loadContextTokens(account.accountId);
    await sendMediaFile({
      opts: { baseUrl, token: account.botToken },
      to: target,
      filePath: file,
      text,
      contextToken: getContextToken(account.accountId, target),
    });
    console.error(`✅ 已发送媒体给 ${target}（${file}${text ? " + 文本" : ""}）`);
  } else {
    const push = createWeixinPush(account, baseUrl);
    await push(target, text);
    console.error(`✅ 已推送给 ${target}`);
  }
} catch (err) {
  console.error(`❌ 发送失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(4);
}
