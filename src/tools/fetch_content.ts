/**
 * fetch_content tool
 *
 * URL → 干净 markdown 正文。
 *
 * 实现思路：
 *   1. 用 chrome-launcher 启动系统已装的 Chrome / Edge / Brave 等 Chromium 系浏览器（用户能看到窗口弹出，体感强）
 *   2. 通过 CDP 给新 tab 导航到目标 URL，等 load 完成
 *   3. 抓 JS 渲染后的 `document.documentElement.outerHTML`
 *   4. jsdom + @mozilla/readability 提正文
 *   5. turndown 转 markdown
 *   6. Chrome 窗口留着，用户可以继续看
 *
 * Day 1 决策：
 *   - 不下载 puppeteer 自带 Chromium（150MB+），跑用户机器现有的 Chrome
 *   - chrome 实例进程内缓存一次，多次抓取复用，每次新开 tab
 *   - 给 SPA 留 1.5s 渲染缓冲
 */

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
});

export type FetchContentInput = Static<typeof schema>;

export interface FetchContentDetails {
  title: string;
  finalUrl: string;
  wordCount: number;
  htmlBytes: number;
  markdownBytes: number;
}

// 进程内 Chrome 缓存。第一次 fetch 时启动，后续复用。
let cachedChrome: LaunchedChrome | undefined;

async function getChrome(): Promise<LaunchedChrome> {
  if (cachedChrome) return cachedChrome;
  cachedChrome = await launchChrome({
    chromeFlags: ["--new-window"],
    startingUrl: "about:blank",
  });
  return cachedChrome;
}

const SPA_RENDER_BUFFER_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 30_000;

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

export function createFetchContentTool(): AgentTool<typeof schema> {
  return {
    name: "fetch_content",
    label: "抓取网页内容",
    description:
      "抓取一个 URL，返回干净的 markdown 正文。" +
      "实现：调起用户系统已装的 Chrome / Edge / Brave 等 Chromium 系浏览器（用户能看到窗口弹出），" +
      "通过 CDP 抓渲染后 HTML，再用 readability + turndown 提取正文转 markdown。" +
      "适用：公众号文章、博客、新闻、文档站这类有明确正文结构的页面。" +
      "局限：用户机器必须装 Chromium 系浏览器（Safari/Firefox-only 用户不行）；纯 SPA 类应用（如 X 时间线、小红书）效果不稳定；视频站只能拿到页面元数据，字幕需要专门工具。",
    parameters: schema,
    async execute(_toolCallId, { url }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(
          `Invalid URL: ${url}（必须以 http:// 或 https:// 开头）`,
        );
      }

      const chrome = await getChrome();

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

        const value = evalResult.result.value as {
          html: string;
          finalUrl: string;
        };
        const { html, finalUrl } = value;

        const dom = new JSDOM(html, { url: finalUrl });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.content) {
          throw new Error(`Readability 提取正文失败：${url}`);
        }

        const td = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        });
        const markdown = td.turndown(article.content);
        const wordCount = (article.textContent ?? "").trim().length;
        const title = article.title ?? "(无标题)";

        const fullText =
          `# ${title}\n\n` +
          `${markdown}\n\n` +
          `---\n来源：${finalUrl}\n字数：${wordCount}`;

        return {
          content: [{ type: "text", text: fullText }],
          details: {
            title,
            finalUrl,
            wordCount,
            htmlBytes: html.length,
            markdownBytes: markdown.length,
          },
        };
      } finally {
        await client.close();
        // 不调 CDP.Close({ port, id: target.id })，让 tab 留着给用户继续看
      }
    },
  };
}
