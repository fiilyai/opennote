#!/usr/bin/env node
/**
 * collect.mjs — 采集最近的 AI / 科技 / 科技金融热点候选，吐一份紧凑清单到 stdout。
 *
 * 用法：
 *   node collect.mjs [--hours 48] [--min-points 20] [--limit 15] [HN关键词...]
 *
 * 两个池子：
 *   - 国际：Hacker News 的 Algolia 公共 API（JSON、无 key、无 UA 门槛，按点数排序）。
 *   - 国内：几个稳定的中文科技 RSS（雷锋网偏 AI、36氪/钛媒体偏创投科技金融、IT之家偏科技），
 *           凑齐 AI / 科技 / 科技金融三个面，省得清一色英文。
 *
 * 脚本只做机械活——**跨源去重**（同一条新闻别出两遍）+ **粗分类**（AI / 科技 / 科技金融，
 * 给挑选当提示）。真正「挑哪 5+5、三类怎么配平」交给上层模型判断（见 SKILL.md）。
 *
 * 想加源：往 DOMESTIC_FEEDS 里加 RSS 即可，解析/去重/分类自动套上。
 */

const HN_API = "https://hn.algolia.com/api/v1/search";
const HN_QUERIES = ["AI", "LLM", "GPT", "Claude", "agent", "open source model"];

// 国内中文科技 RSS（都验过可直连、返回标准 RSS 2.0）。
const DOMESTIC_FEEDS = [
  { name: "雷锋网", url: "https://www.leiphone.com/feed" },
  { name: "36氪", url: "https://36kr.com/feed" },
  { name: "钛媒体", url: "https://www.tmtpost.com/rss.xml" },
  { name: "IT之家", url: "https://www.ithome.com/rss/" },
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const opts = { hours: 48, minPoints: 20, limit: 15, queries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hours") opts.hours = Number(argv[++i]);
    else if (a === "--min-points") opts.minPoints = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else opts.queries.push(a);
  }
  if (opts.queries.length === 0) opts.queries = HN_QUERIES;
  return opts;
}

// 粗分类：科技金融（资本动向）优先识别 → AI → 其余算科技。给挑选当提示，不求精准。
const RE_FINANCE =
  /融资|投资|IPO|上市|估值|收购|并购|股价|营收|市值|亿美元|亿元|百万美元|轮|基金|风投|创投|VC|降息|美债|汇率|筹资|募资|财报|funding|raises?|valuation|acquir|merger|\bIPO\b|billion|S&P|stock|shares/i;
const RE_AI =
  /\bAI\b|人工智能|大模型|模型|LLM|GPT|Claude|Gemini|Llama|智能体|生成式|多模态|具身|机器人|agent|深度学习|神经网络/i;

function categorize(title) {
  if (RE_FINANCE.test(title)) return "科技金融";
  if (RE_AI.test(title)) return "AI";
  return "科技";
}

// 去重键：抹掉空白与标点、转小写，跨源识别「同一条」。
function normKey(title) {
  return title.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// 极简 RSS 解析：按 <item> 切块，每块取第一个 <title> 和第一个 <link>
// （它俩都排在巨大的 <content:encoded> 前面，第一处匹配就是正主）。
function parseRSS(xml) {
  const items = [];
  const chunks = xml.split(/<item[\s>]/i).slice(1); // 丢掉 channel 头
  for (const chunk of chunks) {
    const title = chunk.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    // <link>url</link>（可能裹 CDATA）或 atom 的 <link href="url"/>
    const link =
      chunk.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ||
      chunk.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    if (!title || !link) continue;
    items.push({ title: decodeEntities(title), url: decodeEntities(link) });
  }
  return items;
}

async function fetchText(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHN(queries, sinceUnix, minPoints, limit) {
  const seen = new Map();
  const results = await Promise.allSettled(
    queries.map(async (q) => {
      const url =
        `${HN_API}?query=${encodeURIComponent(q)}&tags=story` +
        `&numericFilters=created_at_i>${sinceUnix},points>=${minPoints}&hitsPerPage=40`;
      const data = JSON.parse(await fetchText(url));
      return data.hits ?? [];
    }),
  );
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const h of r.value) {
      if (h.title && !seen.has(h.objectID)) seen.set(h.objectID, h);
    }
  }
  return [...seen.values()]
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, limit)
    .map((h) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
    }));
}

async function fetchDomestic(feeds, perFeed) {
  const results = await Promise.allSettled(
    feeds.map(async (f) => ({ name: f.name, items: parseRSS(await fetchText(f.url)).slice(0, perFeed) })),
  );
  const groups = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  // 轮转交错：feed1[0], feed2[0], …, feed1[1], feed2[1], … —— 各源都露脸，别让一家占满。
  const out = [];
  for (let i = 0; i < perFeed; i++) {
    for (const g of groups) {
      if (g.items[i]) out.push({ ...g.items[i], source: g.name });
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sinceUnix = Math.floor(Date.now() / 1000) - opts.hours * 3600;

  const [intl, domesticRaw] = await Promise.all([
    fetchHN(opts.queries, sinceUnix, opts.minPoints, opts.limit).catch((e) => {
      process.stderr.write(`collect: 国际源(HN)失败：${e.message}\n`);
      return [];
    }),
    fetchDomestic(DOMESTIC_FEEDS, 6),
  ]);

  // 跨源去重：先收国际的标题键，国内再撞掉重复（同一条中外都报时只留一处）。
  const keys = new Set();
  const dedupe = (items) =>
    items.filter((it) => {
      const k = normKey(it.title);
      if (keys.has(k)) return false;
      keys.add(k);
      return true;
    });
  const intlClean = dedupe(intl);
  const domesticClean = dedupe(domesticRaw).slice(0, opts.limit + 5);

  const out = [];
  out.push(`## 国际（Hacker News 近 ${opts.hours}h，按热度）`);
  if (intlClean.length === 0) out.push("（本时段没采集到）");
  for (const it of intlClean) {
    out.push(`- [${categorize(it.title)}] (▲${it.points} 💬${it.comments}) ${it.title}\n  ${it.url}`);
  }
  out.push("");
  out.push("## 国内（中文科技 RSS，近期）");
  if (domesticClean.length === 0) out.push("（本时段没采集到）");
  for (const it of domesticClean) {
    out.push(`- [${categorize(it.title)}] ${it.title}\n  ${it.url}  （${it.source}）`);
  }

  process.stderr.write(
    `collect: 国际 ${intlClean.length} 条、国内 ${domesticClean.length} 条（已去重）\n`,
  );
  process.stdout.write(out.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`collect: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
