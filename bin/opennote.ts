#!/usr/bin/env node

/**
 * opennote CLI launcher.
 * dev: `pnpm dev` → tsx 直跑这个文件
 * prod: `pnpm build` 后 `node dist/bin/opennote.js` → 同样跑这里
 */

import { run } from "../src/cli.js";

run(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nopennote: ${message}`);
  process.exit(1);
});
