/**
 * 共享路径工具。
 */

import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** 把 `~` / `~/...` 展开成绝对路径，其它原样返回。 */
export function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * 从当前模块向上找到含 package.json 的目录 = 包根。
 * dev（tsx 跑 src/...）和 build（dist/src/...）层级不同，向上找比写死相对层数稳。
 */
export function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
