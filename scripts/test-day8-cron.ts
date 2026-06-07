/**
 * Day 8 回归测试：定时任务（cron）。
 *
 * 跑法：
 *   pnpm tsx scripts/test-day8-cron.ts
 *
 * 纯单元，不跑 LLM、不联网、不要 API key。验证：
 *   1. cron 表达式解析：合法写法、非法写法报错
 *   2. cronMatches：到点 / 不到点 / 日与周「或」
 *   3. CronStateStore：markRun/getLastRun、持久化、坏文件不崩
 *   4. TasksStore + manage：建/改/删运行时任务、cron 校验、名字去重、合并 yaml
 *   5. 调度器：到点触发一次、防重复、停用不跑、动态新建即生效、abort 能停
 *   6. /cron 命令：list / run / add / rm / on-off / 未知（通道无关，不碰 agent）
 */

import { rmSync } from "node:fs";

import { parseCron, cronMatches } from "../src/automation/cron-expr.js";
import { CronStateStore } from "../src/automation/store.js";
import { TasksStore } from "../src/automation/tasks-store.js";
import { addUserTask, mergedTasks, validateCron } from "../src/automation/manage.js";
import { runScheduler } from "../src/automation/scheduler.js";
import { handleSessionCommand, type CronCommandDeps } from "../src/session/commands.js";
import type { CronTask } from "../src/config.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}`);
  }
}

const STATE_TMP = "/tmp/opennote-day8-state.json";
const TASKS_TMP = "/tmp/opennote-day8-tasks.json";

function exprForMinute(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

/** 跑一轮调度器：起一个 tick 让它处理一遍，然后 abort。 */
async function runOneTick(opts: {
  getTasks: () => CronTask[];
  stateStore: CronStateStore;
  fired: string[];
}): Promise<void> {
  const controller = new AbortController();
  const p = runScheduler({
    getTasks: opts.getTasks,
    stateStore: opts.stateStore,
    runTask: async (t) => void opts.fired.push(t.name),
    abortSignal: controller.signal,
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 60));
  controller.abort();
  await p;
}

async function main(): Promise<void> {
  // ---------- 1. 解析 ----------
  check("`*` 全集（分钟 0-59）", parseCron("* * * * *").minute.size === 60);
  check("单值", parseCron("30 9 * * *").minute.has(30) && parseCron("30 9 * * *").hour.has(9));
  check("范围 a-b", [1, 2, 3, 4, 5].every((h) => parseCron("0 1-5 * * *").hour.has(h)));
  check("列表 a,b,c", parseCron("0,15,30,45 * * * *").minute.size === 4);
  check("步长 */n", parseCron("*/15 * * * *").minute.size === 4 && parseCron("*/15 * * * *").minute.has(45));
  check("范围步长 a-b/n", parseCron("0 0-12/6 * * *").hour.size === 3);
  check("周日 7 归一到 0", parseCron("0 0 * * 7").dow.has(0));
  check("字段数不对报错", validateCron("* * * *") !== null);
  check("取值越界报错", validateCron("99 * * * *") !== null);
  check("合法表达式校验通过", validateCron("0 9 * * 1-5") === null);

  // ---------- 2. 匹配 ----------
  const at930 = parseCron("30 9 * * *");
  check("到点命中", cronMatches(at930, new Date(2026, 5, 6, 9, 30, 0)));
  check("差一分钟不命中", !cronMatches(at930, new Date(2026, 5, 6, 9, 31, 0)));
  const domOrDow = parseCron("0 0 1 * 1");
  check("日命中即可", cronMatches(domOrDow, new Date(2026, 5, 1, 0, 0)));
  check("周一命中即可", cronMatches(domOrDow, new Date(2026, 5, 8, 0, 0)));
  check("既非1号也非周一→不命中", !cronMatches(domOrDow, new Date(2026, 5, 9, 0, 0)));

  // ---------- 3. 状态存储 ----------
  rmSync(STATE_TMP, { force: true });
  const state = new CronStateStore(STATE_TMP);
  check("初始 lastRun=0", state.getLastRun("foo") === 0);
  state.markRun("foo", 1717660800000, "成功");
  check("markRun 后取回时间", state.getLastRun("foo") === 1717660800000);
  check("取回状态", state.getLastStatus("foo") === "成功");
  check("重新加载持久化", new CronStateStore(STATE_TMP).getLastRun("foo") === 1717660800000);
  rmSync(STATE_TMP, { force: true });

  // ---------- 4. TasksStore + manage ----------
  rmSync(TASKS_TMP, { force: true });
  const store = new TasksStore(TASKS_TMP);
  check("空 store list=[]", store.list().length === 0);

  const t1 = addUserTask(store, { at: "0 9 * * *", prompt: "扫AI热点推给我" });
  check("addUserTask 落盘", store.list().length === 1);
  check("没给名字会自动起", !!t1.name && t1.name.length > 0);
  check("新建默认启用", t1.enabled === true);

  // 名字去重
  const a = addUserTask(store, { name: "日报", at: "0 9 * * *", prompt: "x" });
  const b = addUserTask(store, { name: "日报", at: "0 9 * * *", prompt: "y" });
  check("同名自动去重", a.name === "日报" && b.name !== "日报");

  // 非法 cron 抛错
  let threw = false;
  try {
    addUserTask(store, { at: "bad", prompt: "x" });
  } catch {
    threw = true;
  }
  check("非法 cron 建任务抛错", threw);

  // setEnabled / remove
  check("setEnabled 改启用", store.setEnabled("日报", false) && store.get("日报")!.enabled === false);
  check("remove 删任务", store.remove("日报") && !store.get("日报"));
  check("remove 不存在返回 false", store.remove("nope") === false);

  // 重新加载（多实例靠文件一致）
  check("另一实例读到同样的任务", new TasksStore(TASKS_TMP).list().length === store.list().length);

  // 合并 yaml + store（同名 store 覆盖）
  const cfg: CronTask[] = [{ name: "yaml任务", at: "0 8 * * *", prompt: "c" }, { name: "共享", at: "0 8 * * *", prompt: "来自yaml" }];
  store.upsert({ name: "共享", at: "0 8 * * *", prompt: "来自store", enabled: true });
  const merged = mergedTasks(cfg, store);
  check("合并含 yaml 独有", merged.some((t) => t.name === "yaml任务"));
  check("同名 store 覆盖 yaml", merged.find((t) => t.name === "共享")?.prompt === "来自store");
  rmSync(TASKS_TMP, { force: true });

  // ---------- 5. 调度器 ----------
  // (a) 到点触发一次
  {
    rmSync(STATE_TMP, { force: true });
    const now = new Date();
    const tasks: CronTask[] = [{ name: "t1", at: exprForMinute(now), prompt: "x" }];
    const fired: string[] = [];
    await runOneTick({ getTasks: () => tasks, stateStore: new CronStateStore(STATE_TMP), fired });
    check("到点触发一次", fired.length === 1 && fired[0] === "t1");
    rmSync(STATE_TMP, { force: true });
  }

  // (b) 本分钟已标记 → 不重复
  {
    rmSync(STATE_TMP, { force: true });
    const now = new Date();
    const st = new CronStateStore(STATE_TMP);
    st.markRun("t1", now.getTime(), "成功");
    const tasks: CronTask[] = [{ name: "t1", at: exprForMinute(now), prompt: "x" }];
    const fired: string[] = [];
    await runOneTick({ getTasks: () => tasks, stateStore: st, fired });
    check("同一分钟不重复触发", fired.length === 0);
    rmSync(STATE_TMP, { force: true });
  }

  // (c) 停用不跑
  {
    rmSync(STATE_TMP, { force: true });
    const now = new Date();
    const tasks: CronTask[] = [{ name: "t1", at: exprForMinute(now), prompt: "x", enabled: false }];
    const fired: string[] = [];
    await runOneTick({ getTasks: () => tasks, stateStore: new CronStateStore(STATE_TMP), fired });
    check("停用任务不触发", fired.length === 0);
    rmSync(STATE_TMP, { force: true });
  }

  // (d) 动态任务表：调度器每 tick 通过 getTasks() 重新取（provider 而非启动时快照），
  // 所以运行时新建的任务下一 tick 就会被读到、不用重启。这里验「provider 被调用 + 当下任务被触发」。
  {
    rmSync(STATE_TMP, { force: true });
    const now = new Date();
    let calls = 0;
    const fired: string[] = [];
    await runOneTick({
      getTasks: () => {
        calls += 1;
        return [{ name: "late", at: exprForMinute(now), prompt: "x" }]; // 每次新读
      },
      stateStore: new CronStateStore(STATE_TMP),
      fired,
    });
    check("每 tick 通过 getTasks 重读任务表（支持运行时新建）", calls >= 1 && fired.includes("late"));
    rmSync(STATE_TMP, { force: true });
  }

  // (e) 非法表达式被剔除、能正常返回
  {
    const tasks: CronTask[] = [{ name: "bad", at: "not a cron", prompt: "x" }];
    const fired: string[] = [];
    await runOneTick({ getTasks: () => tasks, stateStore: new CronStateStore(STATE_TMP), fired });
    check("非法表达式不触发、不挂起", fired.length === 0);
    rmSync(STATE_TMP, { force: true });
  }

  // ---------- 6. /cron 命令 ----------
  {
    rmSync(STATE_TMP, { force: true });
    const cfg2: CronTask[] = [{ name: "ai-radar", at: "0 21 * * *", prompt: "扫热点" }];
    const runtime: CronTask[] = [];
    const triggered: string[] = [];
    const deps: CronCommandDeps = {
      list: () => [...cfg2, ...runtime],
      stateStore: new CronStateStore(STATE_TMP),
      trigger: (name) => {
        if (![...cfg2, ...runtime].some((t) => t.name === name)) return false;
        triggered.push(name);
        return true;
      },
      add: (input) => {
        if (validateCron(input.at)) return { ok: false, error: "时间格式不对" };
        const task: CronTask = { name: input.name || "auto", at: input.at, prompt: input.prompt, enabled: true };
        runtime.push(task);
        return { ok: true, task };
      },
      remove: (name) => {
        const i = runtime.findIndex((t) => t.name === name);
        if (i >= 0) { runtime.splice(i, 1); return "removed"; }
        return cfg2.some((t) => t.name === name) ? "config" : "missing";
      },
      setEnabled: (name, enabled) => {
        const rt = runtime.find((t) => t.name === name);
        if (rt) { rt.enabled = enabled; return "store"; }
        const c = cfg2.find((t) => t.name === name);
        if (c) { c.enabled = enabled; return "config"; }
        return "missing";
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentStub = { state: { messages: [], model: {} } } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cStub = {} as any;
    const cmd = (body: string) => handleSessionCommand(body, agentStub, cStub, deps);

    check("/cron list 列出 yaml 任务", (await cmd("/cron"))!.includes("ai-radar"));

    const add = await cmd("/cron add 日报 0 9 * * * 扫AI热点推给我");
    check("/cron add 建任务", runtime.length === 1 && runtime[0]!.name === "日报" && add!.includes("已建"));
    check("/cron add 后 list 含新任务", (await cmd("/cron"))!.includes("日报"));

    const addBad = await cmd("/cron add 缺字段 0 9");
    check("/cron add 字段不足有提示", addBad!.includes("用法"));

    const runReply = await cmd("/cron run 日报");
    check("/cron run 触发", runReply!.includes("已触发") && triggered.includes("日报"));
    check("/cron off 停用 store 任务", (await cmd("/cron off 日报"))!.includes("停用") && runtime[0]!.enabled === false);
    check("/cron off 配置任务带提示", (await cmd("/cron off ai-radar"))!.includes("配置"));
    check("/cron rm 删运行时任务", (await cmd("/cron rm 日报"))!.includes("已删") && runtime.length === 0);
    check("/cron rm 配置任务删不掉", (await cmd("/cron rm ai-radar"))!.includes("删不了"));
    check("没开 cron 通道友好提示", (await handleSessionCommand("/cron", agentStub, cStub, undefined))!.includes("没开"));
    rmSync(STATE_TMP, { force: true });
  }

  console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
  if (failed === 0) {
    console.log("✅ Day 8 定时任务测试通过");
    process.exit(0);
  } else {
    console.log("❌ Day 8 定时任务测试失败");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test] error:", err);
  process.exit(1);
});
