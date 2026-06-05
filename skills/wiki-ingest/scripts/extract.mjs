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

// 标题 → 文件名 slug：中文/英文/数字保留，空白转单个连字符，标点/符号（全角逗号、书名号、
// 问号、原文里的连字符等）直接删掉——只让空格留连字符，避免文件名一长串 `-`。
function slugify(s) {
  const cleaned = (s || "")
    .trim()
    .replace(/\s+/g, "-") // 空白 → 连字符（分隔英文词）
    .replace(/[^\p{L}\p{N}-]+/gu, "") // 其余标点/符号删掉，不留连字符
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned.slice(0, 40) || "untitled";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function buildOut(title, markdown, finalUrl, wordCount) {
  return (
    `# ${title}\n\n` +
    `${markdown}\n\n` +
    `---\n来源：${finalUrl || "(未知)"}\n字数：${wordCount}`
  );
}

// 图片扩展名：优先微信 wx_fmt 参数，其次 content-type，再 URL 后缀，兜底 .img。
function imageExt(url, contentType) {
  const fmt = url.match(/[?&]wx_fmt=(\w+)/i)?.[1]?.toLowerCase();
  if (fmt) return `.${fmt === "jpeg" ? "jpg" : fmt}`;
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("svg")) return ".svg";
  const m = url.match(/\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i);
  return m ? `.${m[1].toLowerCase().replace("jpeg", "jpg")}` : ".img";
}

async function fetchImage(url, referer, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        // 微信图片（mmbiz.qpic.cn）查 Referer 防盗链，带上源页就放行。
        ...(referer ? { Referer: referer } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// 把 markdown 里的远程图片下载到 raw/assets/<folder>/，链接换成相对路径。
// 下不下来的（防盗链 / 404 / 超时）保留原链，不让整篇 ingest 失败。
async function downloadImages(markdown, rawDir, folder, referer) {
  const re = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
  const urls = [
    ...new Set(
      [...markdown.matchAll(re)]
        .map((m) => m[1])
        .filter((u) => /^https?:\/\//i.test(u)),
    ),
  ];
  if (urls.length === 0) return { markdown, downloaded: 0, failed: 0 };

  const assetDir = path.join(rawDir, "assets", folder);
  mkdirSync(assetDir, { recursive: true });

  const map = new Map();
  let failed = 0;
  await Promise.all(
    urls.map(async (url, i) => {
      try {
        const res = await fetchImage(url, referer, 15_000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error("空文件");
        const fname = `img-${i + 1}${imageExt(url, res.headers.get("content-type"))}`;
        writeFileSync(path.join(assetDir, fname), buf);
        map.set(url, `assets/${folder}/${fname}`);
      } catch {
        failed += 1; // 单张失败不影响其他，保留原链
      }
    }),
  );

  let out = markdown;
  for (const [url, local] of map) out = out.split(url).join(local);
  return { markdown: out, downloaded: map.size, failed };
}

function makeTurndown() {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  // 默认 turndown 会把图片 alt 里的 `_` 转义成 `\_`（如 slide_08 → slide\_08），
  // Obsidian 对带反斜杠转义的 alt 不渲染图片。自定义 image 规则：alt 用原始文本（只去掉
  // 会破坏语法的 [] 和换行），不转义；src 原样。
  td.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node.getAttribute("alt") || "").replace(/[[\]\n]+/g, " ").trim();
      const src = node.getAttribute("src") || "";
      // 前后加空行让图片独占一段，否则紧跟的文字会和图挤在同一行（turndown 默认把 img 当行内）。
      return src ? `\n\n![${alt}](${src})\n\n` : "";
    },
  });
  return td;
}

// 懒加载图片：微信等站把真 URL 放 data-src，src 只是 1x1 占位 svg。turndown 只认 src，
// 所以转换前先把 data-src（及常见变体）回填到 src，否则只抓得到占位、下载不到真图。
function unlazyImages(doc) {
  for (const img of doc.querySelectorAll("img")) {
    const real =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-actualsrc") ||
      img.getAttribute("data-backsrc");
    if (real) img.setAttribute("src", real);
  }
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

  // 懒加载图片 data-src → src（turndown 才取得到真 URL）。微信和 readability 通道都受益。
  unlazyImages(doc);

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

async function main() {
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

  // --save：脚本按真实标题生成文件名、自己写盘，文件名不交给模型猜；
  // 顺便把图片下载到本地、markdown 链接换成相对路径。
  if (flags.save) {
    const folder = `${flags.date || today()}-${slugify(title)}`;
    const dest = path.join(flags.save, `${folder}.md`);
    const { markdown: localMd, downloaded, failed } = await downloadImages(
      markdown,
      flags.save,
      folder,
      finalUrl,
    );
    const out = buildOut(title, localMd, finalUrl, wordCount);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, out + "\n");
    const imgNote =
      downloaded || failed
        ? `，图片 ${downloaded} 张${failed ? `（${failed} 张没下下来，保留原链）` : ""}`
        : "";
    process.stderr.write(
      `extract: 已存 ${dest}（标题「${title}」，${wordCount} 字${imgNote}）\n`,
    );
    process.stdout.write(out + "\n");
    return;
  }

  // 不落盘：原样输出（图片保持外链，没地方存）。
  process.stdout.write(buildOut(title, markdown, finalUrl, wordCount) + "\n");
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
