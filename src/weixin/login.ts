/**
 * 扫码登录（移植自 openclaw-weixin 的 auth/login-qr.ts，去掉 openclaw 依赖）。
 * 流程：get_bot_qrcode 取码 → 终端画二维码 → 轮询 get_qrcode_status 到 confirmed。
 * 详见 docs/weixin-ilink-integration.md §1.4。
 */

import qrcode from "qrcode-terminal";

import type { AccountRecord } from "./accounts.js";

const BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH = 3;

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function trailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchQrcode(baseUrl: string): Promise<QRCodeResponse> {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    trailingSlash(baseUrl),
  );
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`取二维码失败 HTTP ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollStatus(baseUrl: string, qr: string): Promise<StatusResponse> {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`,
    trailingSlash(baseUrl),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`轮询状态失败 HTTP ${res.status}`);
    return (await res.json()) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function renderQr(content: string): void {
  qrcode.generate(content, { small: true });
  process.stdout.write(`\n如果二维码没显示出来，用浏览器打开下面链接再扫：\n${content}\n\n`);
}

/**
 * 跑完整登录流程，成功返回账户记录。timeoutMs 是整体等待扫码的上限。
 */
export async function login(
  baseUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<AccountRecord> {
  let qr = await fetchQrcode(baseUrl);
  process.stdout.write("用微信扫描下面的二维码完成登录：\n\n");
  renderQr(qr.qrcode_img_content);

  const deadline = Date.now() + (opts.timeoutMs ?? 8 * 60_000);
  let refreshes = 0;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollStatus(baseUrl, qr.qrcode);
    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("👀 已扫码，请在微信里确认...\n");
          scannedPrinted = true;
        }
        break;
      case "expired": {
        refreshes += 1;
        if (refreshes > MAX_QR_REFRESH) {
          throw new Error("二维码多次过期，请重新运行 opennote login");
        }
        process.stdout.write(`⏳ 二维码过期，刷新中 (${refreshes}/${MAX_QR_REFRESH})...\n`);
        qr = await fetchQrcode(baseUrl);
        scannedPrinted = false;
        renderQr(qr.qrcode_img_content);
        break;
      }
      case "confirmed": {
        if (!status.ilink_bot_id) throw new Error("登录确认了但服务端没返回 ilink_bot_id");
        return {
          accountId: status.ilink_bot_id,
          botToken: status.bot_token ?? "",
          baseUrl: status.baseurl,
          userId: status.ilink_user_id,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("登录超时，请重试");
}
