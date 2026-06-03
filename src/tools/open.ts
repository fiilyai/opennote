/**
 * open tool
 *
 * 用系统默认应用打开任意目标——URL 或本地文件。
 *
 * - URL（http/https）→ 系统默认浏览器
 * - 文件路径 → 系统默认应用（.pdf → 预览、.png → 图片查看、.md → 默认 markdown viewer 等）
 *
 * 仅触发打开动作，不返回内容。要拿网页内容请用 `browser`、要读本地文件用 `read`。
 *
 * 路径解析：跟 read / write / edit 一样，相对路径会按 cwd 解析（默认 `~/.opennote/notes/`）。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import open from "open";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const schema = Type.Object({
  target: Type.String({
    description:
      "要打开的目标：完整 URL（以 http:// / https:// 开头）、绝对路径、~/ 路径、或相对 cwd 的纯文件名。",
  }),
});

export type OpenInput = Static<typeof schema>;

export interface OpenDetails {
  target: string;
  resolved: string;
  kind: "url" | "file";
  platform: NodeJS.Platform;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function resolveLocalPath(target: string, cwd: string): string {
  const expanded = expandTilde(target);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(cwd, expanded);
}

export function createOpenTool(cwd: string): AgentTool<typeof schema> {
  return {
    name: "open",
    label: "用默认应用打开",
    description:
      "用系统默认应用打开一个 URL 或本地文件。" +
      "URL（http/https）会在默认浏览器里弹出；本地文件会用系统默认应用打开（PDF→预览、图片→图片查看、markdown→默认 viewer）。" +
      "本地路径支持：绝对路径、`~/` 开头的 home 路径、或者相对路径（按 cwd 解析，cwd 跟 read/write/edit 一致）。" +
      "只触发打开动作，不抓内容、不返回正文。要读 URL 内容用 browser；要读本地文件内容用 read。",
    parameters: schema,
    async execute(_toolCallId, { target }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const isUrl = /^https?:\/\//i.test(target);

      if (!isUrl) {
        const resolved = resolveLocalPath(target, cwd);
        if (!existsSync(resolved)) {
          throw new Error(`File not found: ${target}（解析为 ${resolved}）`);
        }
        await open(resolved);
        return {
          content: [{ type: "text", text: `已用系统默认应用打开 ${target}` }],
          details: { target, resolved, kind: "file", platform: process.platform },
        };
      }

      await open(target);
      return {
        content: [{ type: "text", text: `已在系统默认浏览器打开 ${target}` }],
        details: { target, resolved: target, kind: "url", platform: process.platform },
      };
    },
  };
}
