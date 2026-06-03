#!/usr/bin/env node
/**
 * extract.mjs — HTML 文件 → 干净 markdown 正文。
 *
 * 用法：
 *   node extract.mjs <html 文件> [--save <raw目录>] [--date YYYY-MM-DD] [--url 源URL]
 *
 * 配 browser tool 用：browser 把渲染后 HTML 落盘（首行写 <!--OPENNOTE_FINAL_URL:...-->），
 * 这个脚本读文件、用 readability + turndown 提正文转 markdown，公众号走 #js_content 专门通道。
 * markdown 始终打到 stdout（模型不用把正文当参数重抄一遍）。
 *
 * 文件名由脚本定，不让模型瞎猜：传 --save <目录>，脚本按真实标题生成
 * `<目录>/<date>-<标题slug>.md` 自己写盘，并把存到哪打到 stderr。不传 --save 就只打 stdout
 * （配 `| tee raw/xxx.md` 也行，但那需要预先知道标题，一般用 --save）。
 *
 * 为什么是脚本不是 tool：纯 CPU 的 DOM 解析，按需起停就行；起浏览器那种有状态的活才留在 tool 里。
 * 依赖 jsdom / @mozilla/readability / turndown，从仓库 node_modules 解析（脚本在包内，向上能找到）。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const FINAL_URL_MARKER = "OPENNOTE_FINAL_URL";
// 正文短于这个字数就当空壳处理（和公众号 #js_content 的下限一致）。
const MIN_CONTENT_CHARS = 200;

function die(msg) {
  process.stderr.write(`extract: ${msg}\n`);
  process.exit(1);
}

// 极简 flag 解析：positional + --save/--date/--url。
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--save") flags.save = argv[++i];
    else if (a === "--date") flags.date = argv[++i];
    else if (a === "--url") flags.url = argv[++i];
    else pos.push(a);
  }
  return { flags, pos };
}

// 标题 → 文件名 slug：中文直接保留，空白/标点（含全角逗号、书名号）一律转连字符，截断。
function slugify(s) {
  const cleaned = (s || "")
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned.slice(0, 40) || "untitled";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function makeTurndown() {
  return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
}

// 公众号正文在 #js_content 里、靠 JS 揭开，readability 抓不到。它是 opennote 最主要的抓取
// 对象，所以单独认一下：有 #js_content 就直接取，配 og:title。
function extractWeChat(doc) {
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

function extractArticle(html, finalUrl) {
  const dom = new JSDOM(html, finalUrl ? { url: finalUrl } : undefined);
  const doc = dom.window.document;

  // 公众号走专门通道
  const wechat = extractWeChat(doc);
  if (wechat) return wechat;

  const article = new Readability(doc).parse();
  if (!article || !article.content) {
    die(`Readability 提取正文失败：${finalUrl || "(无源URL)"}`);
  }

  const wordCount = (article.textContent ?? "").trim().length;
  // 正文太短基本是空壳：登录墙 / 付费墙 / 纯 JS 站只渲染了导航。如实失败，别吐个空笔记。
  if (wordCount < MIN_CONTENT_CHARS) {
    die(
      `提取到的正文仅 ${wordCount} 字，疑似空壳/登录墙/纯 JS 站：${finalUrl || "(无源URL)"}`,
    );
  }

  const markdown = makeTurndown().turndown(article.content);
  const title = article.title ?? "(无标题)";
  return { title, markdown, wordCount };
}

function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const file = pos[0];
  if (!file) {
    die("用法：node extract.mjs <html 文件> [--save <raw目录>] [--date YYYY-MM-DD] [--url 源URL]");
  }

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    die(`读不到文件 ${file}：${err.message}`);
  }

  // 最终 URL：优先 --url，其次 browser 写在首行的注释。
  const marker = raw.match(new RegExp(`<!--${FINAL_URL_MARKER}:(.*?)-->`));
  const finalUrl = flags.url || marker?.[1] || "";

  const { title, markdown, wordCount } = extractArticle(raw, finalUrl);

  const out =
    `# ${title}\n\n` +
    `${markdown}\n\n` +
    `---\n来源：${finalUrl || "(未知)"}\n字数：${wordCount}`;

  // --save：脚本按真实标题生成文件名并自己写盘，文件名不交给模型猜。
  if (flags.save) {
    const name = `${flags.date || today()}-${slugify(title)}.md`;
    const dest = path.join(flags.save, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, out + "\n");
    process.stderr.write(`extract: 已存 ${dest}（标题「${title}」，${wordCount} 字）\n`);
  }

  process.stdout.write(out + "\n");
}

main();
