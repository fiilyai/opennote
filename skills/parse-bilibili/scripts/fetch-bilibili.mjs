#!/usr/bin/env node
/**
 * parse-bilibili 脚本：B 站视频 → 中文文字（口播转写）
 *
 * 纯 Node（global fetch / FormData / Blob，Node 18+），不依赖 yt-dlp / lux / ffmpeg，跨平台。
 * 链路：view API 取元信息 → WBI 签名 + playurl 取纯音频流 → 下载 → 硅基 SenseVoice 转写。
 *
 * 用法：  node fetch-bilibili.mjs <bilibili-url-or-BV>
 * Key ： 硅基流动 key，按优先级取：
 *          1. 环境变量 SILICONFLOW_API_KEY
 *          2. 本 skill 目录下的 .env 文件（SILICONFLOW_API_KEY=sk-...，已被 gitignore）
 *        复制同目录 .env.example 为 .env 填上 key 即可。
 * 输出：  结构化 markdown 到 stdout（元信息 + 简介 + 口播转写）
 *
 * 边界：音频 >50MB（约 >1 小时）超硅基单文件上限，脚本报错——长视频切片是后续计划。
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const HEADERS = { "User-Agent": UA, Referer: "https://www.bilibili.com" };
const ASR_ENDPOINT = "https://api.siliconflow.cn/v1/audio/transcriptions";
const ASR_MODEL = "FunAudioLLM/SenseVoiceSmall";
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

// 本 skill 目录下的 .env（key 存这里，已被 gitignore）
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

// WBI 混淆密钥重排表（B 站固定的 64 位置换）
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
  42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
  60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const md5 = (s) => createHash("md5").update(s).digest("hex");

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.json();
}

// 从链接里抠出 BV 号；b23.tv 短链先跟随跳转
async function resolveBvid(input) {
  const direct = input.match(/BV[0-9A-Za-z]+/);
  if (direct) return direct[0];
  if (/b23\.tv/.test(input)) {
    const r = await fetch(input, { headers: HEADERS, redirect: "follow" });
    const m = r.url.match(/BV[0-9A-Za-z]+/);
    if (m) return m[0];
  }
  throw new Error(`无法从链接里解析出 BV 号：${input}`);
}

// 取 WBI 的 mixin key（nav 接口拿 img/sub key，按置换表重排取前 32 位）
async function wbiMixinKey() {
  const nav = await getJSON("https://api.bilibili.com/x/web-interface/nav");
  const { img_url, sub_url } = nav.data.wbi_img;
  const img = img_url.split("/").pop().split(".")[0];
  const sub = sub_url.split("/").pop().split(".")[0];
  const raw = img + sub;
  return MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

// 给请求参数做 WBI 签名，返回带 w_rid 的 query string
function signWbi(params, mixinKey) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

const fmtDuration = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

// 取硅基 key：环境变量优先，否则从本 skill 目录的 .env 加载（.env 已被 gitignore）
function resolveApiKey() {
  if (!process.env.SILICONFLOW_API_KEY) {
    try {
      process.loadEnvFile(ENV_PATH);
    } catch {
      // 没有 .env 文件就算了，由调用方决定怎么提示
    }
  }
  return process.env.SILICONFLOW_API_KEY ?? null;
}

// 把 key 写进本 skill 目录的 .env（用户发来 key 时，skill 一键配置）
function saveApiKey(key) {
  if (!/^sk-\S+$/.test(key)) {
    console.error("这不像硅基流动 key（应以 sk- 开头）。用法: --set-key <sk-...>");
    process.exit(2);
  }
  writeFileSync(ENV_PATH, `SILICONFLOW_API_KEY=${key}\n`);
  console.log(`已保存到 ${ENV_PATH}（key 末四位 …${key.slice(-4)}）。现在可以正常抓取了。`);
}

async function main() {
  const [arg1, arg2] = process.argv.slice(2);

  // 子命令：配置 / 自检 key
  if (arg1 === "--set-key") {
    saveApiKey(arg2 ?? "");
    return;
  }
  if (arg1 === "--check-key") {
    const k = resolveApiKey();
    console.log(k ? `已配置（…${k.slice(-4)}）` : "未配置");
    process.exit(k ? 0 : 1);
  }

  const input = arg1;
  if (!input) {
    console.error("用法: node fetch-bilibili.mjs <bilibili-url-or-BV> | --set-key <sk-...> | --check-key");
    process.exit(2);
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    // 退出码 3 = 缺 key，专门用来让上层 skill 据此走「引导/配置」分支
    console.error(
      "NO_API_KEY 缺少硅基流动 key。两种配法：\n" +
        "  1) 让用户把 key 发来，然后运行：node <skill>/scripts/fetch-bilibili.mjs --set-key <sk-...>\n" +
        "  2) 或设环境变量 SILICONFLOW_API_KEY，或复制 .env.example 为 .env 填上 key。\n" +
        "  key 申请：https://cloud.siliconflow.cn/",
    );
    process.exit(3);
  }

  const bvid = await resolveBvid(input);

  // 1. 元信息
  const view = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (view.code !== 0) throw new Error(`view API 失败：${view.message}`);
  const v = view.data;
  const meta = {
    title: v.title,
    author: v.owner?.name ?? "",
    desc: (v.desc ?? "").trim(),
    duration: v.duration,
    cid: v.cid,
    url: `https://www.bilibili.com/video/${v.bvid}`,
  };

  // 2. WBI 签名 → playurl → 纯音频流（取码率最低的：省流量、足够 ASR 用）
  const mixinKey = await wbiMixinKey();
  const qs = signWbi({ bvid, cid: meta.cid, fnval: 16, fnver: 0, fourk: 1 }, mixinKey);
  const pu = await getJSON(`https://api.bilibili.com/x/player/wbi/playurl?${qs}`);
  if (pu.code !== 0) throw new Error(`playurl 失败：${pu.message}`);
  const audios = pu.data?.dash?.audio ?? [];
  if (!audios.length) throw new Error("没拿到音频流（可能是大会员/付费/特殊视频）");
  const audio = audios.sort((a, b) => a.bandwidth - b.bandwidth)[0];

  // 3. 下载音频（带 Referer，否则 CDN 拒绝）
  const ar = await fetch(audio.baseUrl, { headers: HEADERS });
  if (!ar.ok) throw new Error(`音频下载失败 HTTP ${ar.status}`);
  const buf = Buffer.from(await ar.arrayBuffer());
  if (buf.byteLength > MAX_AUDIO_BYTES) {
    const mb = (buf.byteLength / 1048576).toFixed(1);
    throw new Error(`音频 ${mb}MB 超过硅基 50MB 上限（长视频切片是后续计划，暂不支持）`);
  }

  // 4. 硅基 SenseVoice 转写（DASH 音频是合法 m4a 容器，可直接发，不用 ffmpeg）
  const fd = new FormData();
  fd.append("model", ASR_MODEL);
  fd.append("file", new Blob([buf], { type: "audio/mp4" }), "audio.m4a");
  const asr = await fetch(ASR_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  const asrJson = await asr.json().catch(() => ({}));
  if (!asr.ok) throw new Error(`ASR 失败 HTTP ${asr.status}：${JSON.stringify(asrJson)}`);
  const transcript = (asrJson.text ?? "").trim();

  // 5. 结构化 markdown 输出
  process.stdout.write(
    [
      "---",
      `title: ${meta.title}`,
      `author: ${meta.author}`,
      `source: ${meta.url}`,
      "platform: bilibili",
      `duration: ${fmtDuration(meta.duration)}`,
      "transcribed_by: SenseVoiceSmall",
      "---",
      "",
      `# ${meta.title}`,
      "",
      "## 简介",
      meta.desc || "(无)",
      "",
      "## 口播转写",
      "> 由 SenseVoice 自动转写；英文专名可能听错（Codex/Claude/Opus 等），" +
        "请结合上面的标题与简介校正后再整理。",
      "",
      transcript || "(转写为空)",
      "",
    ].join("\n"),
  );
}

main().catch((e) => {
  console.error(`[parse-bilibili] ${e.message}`);
  process.exit(1);
});
