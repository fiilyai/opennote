/**
 * browser tool
 *
 * 通用的「建立 CDP / 拿渲染后页面」的浏览器原语。职责单一：URL → 渲染后 HTML。
 * 不做正文抽取（那是 wiki-ingest skill 里 extract.mjs 脚本的活），保持通用、可复用。
 *
 * 两条抓取路径，浏览器优先、HTTP 兜底：
 *   A. 浏览器（默认）：用 chrome-launcher 起系统已装的 Chromium 系浏览器，
 *      通过 CDP 抓 JS 渲染后的 HTML，能拿到 SPA / 懒加载的内容。默认 headless 后台抓取，不弹窗。
 *      已经开着就复用、只开新 tab；没开才启动。抓完空闲 3 秒彻底关掉，不常驻、
      不在 dock / 状态栏挂着；3 秒内又来抓取就复用并取消关闭。
 *   B. HTTP 兜底：浏览器起不来 / 端口连不上时，直接 fetch 原始 HTML。
 *      公众号、博客这类服务端渲染的页面，纯 HTTP 就够了。
 *
 * 为什么是 tool 不是脚本：Chrome 实例是有状态的——第一次启动后缓存复用，多次抓取共用
 * 一个窗口、每次新开 tab。脚本每次冷启 Chrome 又慢又开不了窗口复用。所以「起浏览器」留在
 * 长活的 tool 进程里，纯 CPU 的正文抽取（jsdom）才放进按需起停的脚本。
 *
 * 健壮性：
 *   - 缓存的 Chrome 实例会失活（用户手动关了窗口 / 进程崩了），
 *     此时复用旧端口会 ECONNREFUSED。所以连不上就丢缓存、重启一次。
 *   - 浏览器整条路走不通（没装 Chromium / 无图形环境）就退到 HTTP，不直接报错。
 *
 * 上下文铁律：HTML 又大又脏，传 save_to 让工具直接落盘、只回元信息（不回正文），
 * 别把整页 HTML 灌进模型上下文。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { launch as launchChrome, type LaunchedChrome } from "chrome-launcher";
import CDP from "chrome-remote-interface";

const schema = Type.Object({
  url: Type.String({
    description: "要抓取的完整 URL，必须以 http:// 或 https:// 开头。",
  }),
  save_to: Type.Optional(
    Type.String({
      description:
        "可选但强烈建议。给一个相对笔记目录的路径或目录，工具把渲染后 HTML 原样写进去并自动建父目录，" +
        "返回值只给元信息不回正文。**推荐给目录**（以 / 结尾，如 raw/.html/），" +
        "文件名由工具按 URL 自动生成，省得你瞎猜 slug；也可给完整文件名。" +
        "HTML 又大又脏，几乎总该用 save_to 落盘，再用 extract 脚本把文件转成 markdown，不要把整页 HTML 拿回上下文。",
    }),
  ),
});

export type BrowserInput = Static<typeof schema>;

export interface BrowserDetails {
  finalUrl: string;
  htmlBytes: number;
  method: "browser" | "http";
  savedTo?: string;
}

const SPA_RENDER_BUFFER_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;

// 抓到的最终 URL 跟着 HTML 一起落盘（首行注释），extract 脚本据此解析相对链接 / 标题。
const FINAL_URL_MARKER = "OPENNOTE_FINAL_URL";

// 兜底 HTTP 抓取用的桌面 UA，避免被当成爬虫直接挡掉（公众号尤其挑这个）。
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// URL → 中间 HTML 文件名 slug（host + 末段路径）。模型给目录时由工具自动命名，省得瞎猜。
function slugFromUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, "");
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const tail = last.replace(/\.(html?|php|aspx?)$/i, "");
    const slug = [host, tail]
      .filter(Boolean)
      .join("-")
      .replace(/[^\p{L}\p{N}-]+/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return (slug || "page").slice(0, 50);
  } catch {
    return "page";
  }
}

// ECONNREFUSED / socket hang up 这类，基本都是缓存的 Chrome 已经死了。
function isConnectionError(err: unknown): boolean {
  const m = errMessage(err);
  return /ECONNREFUSED|ECONNRESET|socket hang up|connect/i.test(m);
}

// ---- 进程内 Chrome：抓取时启动，空闲 3 秒彻底关掉（不常驻、不在 dock / 状态栏挂着）----
// 连续抓取仍复用同一实例：每次抓取会取消待关定时器；空闲超过 3 秒才真正 kill。

const IDLE_CLOSE_MS = 3_000;

let cachedChrome: LaunchedChrome | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function cancelScheduledClose(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

/** 安排空闲 3 秒后彻底关闭 Chrome；期间再有抓取会取消它。 */
function scheduleClose(): void {
  cancelScheduledClose();
  closeTimer = setTimeout(() => {
    closeTimer = undefined;
    void dropChrome();
  }, IDLE_CLOSE_MS);
}

async function getChrome(): Promise<LaunchedChrome> {
  cancelScheduledClose(); // 又要用了，别关
  if (cachedChrome) return cachedChrome;
  cachedChrome = await launchChrome({
    // headless 后台抓取：不弹窗、不占 dock / 状态栏。CDP 照常工作；懒加载图片靠 extract
    // 的 unlazyImages 从 data-src 取，不依赖可视渲染，所以 headless 不影响抓全图。
    chromeFlags: ["--headless=new", "--disable-gpu"],
  });
  return cachedChrome;
}

async function dropChrome(): Promise<void> {
  cancelScheduledClose();
  const chrome = cachedChrome;
  cachedChrome = undefined;
  if (!chrome) return;
  try {
    await chrome.kill();
  } catch {
    // 进程可能已经没了，忽略
  }
}

/**
 * 供外部在退出时（serve 收到 SIGINT、chat 退出）彻底关掉 Chrome，
 * 不等那 3 秒空闲定时器、不留残余进程。没开过浏览器时是 no-op。
 */
export async function closeBrowser(): Promise<void> {
  await dropChrome();
}

interface RawPage {
  html: string;
  finalUrl: string;
}

// 在一个活着的 Chrome 实例里开新 tab、导航、抓渲染后 HTML。
async function grabViaCDP(
  chrome: LaunchedChrome,
  url: string,
): Promise<RawPage> {
  // 每次抓取开个新 tab，避免污染前一次的页面
  const target = (await CDP.New({
    port: chrome.port,
    url: "about:blank",
  })) as { id: string };

  const client = await CDP({ port: chrome.port, target: target.id });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Page, Runtime } = client as any;

    await Page.enable();

    await withTimeout(
      Promise.all([Page.navigate({ url }), Page.loadEventFired()]),
      NAVIGATION_TIMEOUT_MS,
      `navigate to ${url}`,
    );

    // 给 SPA / 懒加载留一点渲染时间
    await new Promise((r) => setTimeout(r, SPA_RENDER_BUFFER_MS));

    const evalResult = await Runtime.evaluate({
      expression:
        "({ html: document.documentElement.outerHTML, finalUrl: location.href })",
      returnByValue: true,
    });

    return evalResult.result.value as RawPage;
  } finally {
    await client.close();
  }
}

// 路径 A：浏览器抓取。连不上就丢缓存重启一次，再不行才抛出去交给 HTTP 兜底。
async function fetchViaBrowser(url: string): Promise<RawPage> {
  let chrome = await getChrome();
  try {
    return await grabViaCDP(chrome, url);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    // 缓存的 Chrome 失活了（用户关了窗口 / 进程崩了）—— 丢掉、重启一次
    await dropChrome();
    chrome = await getChrome();
    return await grabViaCDP(chrome, url);
  } finally {
    // 用完安排空闲 3 秒彻底关；3 秒内又来抓取会取消它（连续 ingest 仍复用）。
    scheduleClose();
  }
}

// 路径 B：纯 HTTP 抓取。服务端渲染的页面够用，且不依赖图形环境。
async function fetchViaHttp(
  url: string,
  signal?: AbortSignal,
): Promise<RawPage> {
  const res = await withTimeout(
    fetch(url, {
      headers: { "user-agent": DESKTOP_UA, accept: "text/html,*/*" },
      redirect: "follow",
      signal,
    }),
    HTTP_TIMEOUT_MS,
    `http fetch ${url}`,
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return { html, finalUrl: res.url || url };
}

export function createBrowserTool(notesDir: string): AgentTool<typeof schema> {
  return {
    name: "browser",
    label: "浏览器抓取",
    description:
      "用浏览器打开一个 URL，返回渲染后的 HTML（不是 markdown，也不抽正文）。" +
      "优先调起用户系统已装的 Chrome / Edge / Brave 等 Chromium 系浏览器（用户能看到窗口弹出），" +
      "通过 CDP 抓 JS 渲染后的 HTML；浏览器起不来或端口连不上时，自动退回纯 HTTP 抓取。" +
      "适用：任何要拿到页面 DOM 的场景——公众号、博客、新闻、文档站、SPA。" +
      "正文抽取交给后续脚本（如 wiki-ingest 的 extract.mjs）。" +
      "几乎总该传 save_to 把 HTML 落盘——HTML 又大又脏，别拿回上下文。",
    parameters: schema,
    async execute(_toolCallId, { url, save_to }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(
          `Invalid URL: ${url}（必须以 http:// 或 https:// 开头）`,
        );
      }

      // 浏览器优先，失败退 HTTP。两条都挂了，把两边的原因都报出来好排查。
      let page: RawPage;
      let method: "browser" | "http";
      try {
        page = await fetchViaBrowser(url);
        method = "browser";
      } catch (browserErr) {
        if (signal?.aborted) throw new Error("Operation aborted");
        try {
          page = await fetchViaHttp(url, signal);
          method = "http";
        } catch (httpErr) {
          throw new Error(
            `抓取失败：${url}\n` +
              `  浏览器路径：${errMessage(browserErr)}\n` +
              `  HTTP 兜底：${errMessage(httpErr)}`,
          );
        }
      }

      const { html, finalUrl } = page;
      const htmlBytes = Buffer.byteLength(html, "utf8");

      // save_to：HTML 直接落盘（相对路径按笔记目录解析），首行写最终 URL 供 extract 用。
      // 返回值只回元信息，不把整页 HTML 灌进上下文。
      let savedTo: string | undefined;
      if (save_to) {
        // save_to 以 / 结尾 = 目录，文件名按 URL 自动生成；否则当成完整文件名。
        const isDir = /[/\\]$/.test(save_to);
        const base = path.isAbsolute(save_to)
          ? save_to
          : path.join(notesDir, save_to);
        savedTo = isDir ? path.join(base, `${slugFromUrl(finalUrl)}.html`) : base;
        mkdirSync(path.dirname(savedTo), { recursive: true });
        writeFileSync(savedTo, `<!--${FINAL_URL_MARKER}:${finalUrl}-->\n${html}`);
      }

      const text = savedTo
        ? `已抓取（${method}）：${finalUrl}\n` +
          `HTML 共 ${htmlBytes} 字节，已存到 ${savedTo}。\n` +
          `下一步：用 extract 脚本把它转成 markdown，别把 HTML 拿回这里。`
        : html;

      return {
        content: [{ type: "text", text }],
        details: { finalUrl, htmlBytes, method, savedTo },
      };
    },
  };
}
