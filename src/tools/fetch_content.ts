/**
 * fetch_content tool
 *
 * URL → 干净 markdown 正文。
 *
 * 两条抓取路径，浏览器优先、HTTP 兜底：
 *   A. 浏览器（默认）：用 chrome-launcher 起系统已装的 Chromium 系浏览器，
 *      通过 CDP 抓 JS 渲染后的 HTML。能拿到 SPA / 懒加载的内容，用户也能看到窗口。
 *      已经开着浏览器就复用、只开个新 tab；没开才启动。抓完不关，留着复用。
 *   B. HTTP 兜底：浏览器起不来 / 端口连不上时，直接 fetch 原始 HTML。
 *      公众号、博客这类服务端渲染的页面，纯 HTTP 就够了。
 *   两条路抓到 HTML 后，都走同一套 readability + turndown 提正文转 markdown。
 *
 * 健壮性：
 *   - 缓存的 Chrome 实例会失活（用户手动关了窗口 / 进程崩了），
 *     此时复用旧端口会 ECONNREFUSED。所以连不上就丢缓存、重启一次。
 *   - 浏览器整条路走不通（没装 Chromium / 无图形环境）就退到 HTTP，不直接报错。
 *
 * Day 1 决策：
 *   - 不下载 puppeteer 自带 Chromium（150MB+），跑用户机器现有的 Chrome
 *   - chrome 实例进程内缓存复用，多次抓取共用一个窗口、每次新开 tab
 *   - 给 SPA 留 1.5s 渲染缓冲
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { launch as launchChrome, type LaunchedChrome } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const schema = Type.Object({
  url: Type.String({
    description: "要抓取的完整 URL，必须以 http:// 或 https:// 开头。",
  }),
  save_to: Type.Optional(
    Type.String({
      description:
        "可选。给一个相对笔记目录的路径（如 raw/2026-06-01-标题.md），" +
        "工具会把抓到的正文原样直接写进这个文件并自动建父目录。" +
        "存大段原文（raw）时务必用它——别把正文返回后再用 write 工具重写一遍，那会让模型重新生成上万 token、很慢。",
    }),
  ),
});

export type FetchContentInput = Static<typeof schema>;

export interface FetchContentDetails {
  title: string;
  finalUrl: string;
  wordCount: number;
  htmlBytes: number;
  markdownBytes: number;
  method: "browser" | "http";
  savedTo?: string;
}

const SPA_RENDER_BUFFER_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;

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

// ECONNREFUSED / socket hang up 这类，基本都是缓存的 Chrome 已经死了。
function isConnectionError(err: unknown): boolean {
  const m = errMessage(err);
  return /ECONNREFUSED|ECONNRESET|socket hang up|connect/i.test(m);
}

// ---- 进程内 Chrome 缓存。第一次 fetch 时启动，后续复用 ----

let cachedChrome: LaunchedChrome | undefined;

async function getChrome(): Promise<LaunchedChrome> {
  if (cachedChrome) return cachedChrome;
  cachedChrome = await launchChrome({
    chromeFlags: ["--new-window"],
    startingUrl: "about:blank",
  });
  return cachedChrome;
}

async function dropChrome(): Promise<void> {
  const chrome = cachedChrome;
  cachedChrome = undefined;
  if (!chrome) return;
  try {
    await chrome.kill();
  } catch {
    // 进程可能已经没了，忽略
  }
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

function makeTurndown(): TurndownService {
  return new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
}

// 公众号正文在 #js_content 里、靠 JS 揭开，readability 抓不到（HTTP 兜底下尤其明显）。
// 它是 opennote 最主要的抓取对象，所以单独认一下：有 #js_content 就直接取，配 og:title。
function extractWeChat(
  doc: Document,
): { title: string; markdown: string; wordCount: number } | null {
  const node = doc.querySelector("#js_content");
  const text = node?.textContent?.trim() ?? "";
  if (!node || text.length < 200) return null;

  const title =
    doc
      .querySelector("meta[property='og:title']")
      ?.getAttribute("content")
      ?.trim() ||
    doc.querySelector("#activity-name")?.textContent?.trim() ||
    doc.title ||
    "(无标题)";

  const markdown = makeTurndown().turndown(node.innerHTML);
  return { title, markdown, wordCount: text.length };
}

function extractArticle(
  html: string,
  finalUrl: string,
): { title: string; markdown: string; wordCount: number } {
  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  // 公众号走专门通道
  const wechat = extractWeChat(doc);
  if (wechat) return wechat;

  const article = new Readability(doc).parse();
  if (!article || !article.content) {
    throw new Error(`Readability 提取正文失败：${finalUrl}`);
  }

  const markdown = makeTurndown().turndown(article.content);
  const wordCount = (article.textContent ?? "").trim().length;
  const title = article.title ?? "(无标题)";
  return { title, markdown, wordCount };
}

export function createFetchContentTool(notesDir: string): AgentTool<typeof schema> {
  return {
    name: "fetch_content",
    label: "抓取网页内容",
    description:
      "抓取一个 URL，返回干净的 markdown 正文。" +
      "优先调起用户系统已装的 Chrome / Edge / Brave 等 Chromium 系浏览器（用户能看到窗口弹出），" +
      "通过 CDP 抓渲染后 HTML；浏览器起不来或端口连不上时，自动退回纯 HTTP 抓取。" +
      "抓到 HTML 后用 readability + turndown 提取正文转 markdown。" +
      "适用：公众号文章、博客、新闻、文档站这类有明确正文结构的页面。" +
      "局限：纯 SPA 类应用（如 X 时间线、小红书）在 HTTP 兜底下效果不稳定，需要浏览器路径；" +
      "视频站只能拿到页面元数据，字幕需要专门工具。" +
      "要把原文存成文件时，传 save_to 让工具直接落盘，不要拿到返回值后再用 write 重写一遍。",
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
      const { title, markdown, wordCount } = extractArticle(html, finalUrl);

      const fullText =
        `# ${title}\n\n` +
        `${markdown}\n\n` +
        `---\n来源：${finalUrl}\n字数：${wordCount}`;

      // save_to：把正文直接落盘（相对路径按笔记目录解析），模型不必拿到返回值再重写一遍。
      let savedTo: string | undefined;
      if (save_to) {
        savedTo = path.isAbsolute(save_to) ? save_to : path.join(notesDir, save_to);
        mkdirSync(path.dirname(savedTo), { recursive: true });
        writeFileSync(savedTo, fullText);
      }

      const text = savedTo
        ? `（正文已存到 ${savedTo}，共 ${wordCount} 字；无需再用 write 工具写一遍。下面是同一份内容，供你写摘要/概念页用。）\n\n${fullText}`
        : fullText;

      return {
        content: [{ type: "text", text }],
        details: {
          title,
          finalUrl,
          wordCount,
          htmlBytes: html.length,
          markdownBytes: markdown.length,
          method,
          savedTo,
        },
      };
    },
  };
}
