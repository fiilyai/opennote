/**
 * 把定时任务需要的零件装成一个 CronContext（Day 8）。
 *
 * serve 用它起调度器 + 接 /cron 命令；`opennote run` 用它跑单条任务。集中在这里组装，
 * 免得各调用方各搭一套。核心是给定时任务一个**独立的 agent 实例**——不跟消息通道
 * 正在用的 agent 共享 state.messages，cron 触发和你正在聊天就不会互相踩。
 */

import { createOpennoteAgent } from "../agent/create.js";
import { makeApiKeyResolver } from "../agent/model.js";
import type { CronTask, OpennoteConfig } from "../config.js";
import type { CompactionDeps } from "../session/compaction.js";
import { SessionStore } from "../session/store.js";
import { Mutex } from "../utils/mutex.js";
import type { CronCommandDeps } from "../session/commands.js";
import { addUserTask, mergedTasks } from "./manage.js";
import { runCronTask, type CronRunResult } from "./run-task.js";
import { runScheduler } from "./scheduler.js";
import { CronStateStore } from "./store.js";
import { TasksStore } from "./tasks-store.js";
import type { Push } from "../weixin/push.js";

export interface CronContextOpts {
  /** 会话存储；不传则新建一个（和消息通道共用同一个最好，cron 会话 key 带 cron: 前缀不会撞）。 */
  sessionStore?: SessionStore;
  /** 推送函数（微信发送 / 终端打印）。不传则任务只跑不推。 */
  push?: Push;
  /** 任务没配 to 时的默认接收人。 */
  defaultTo?: string;
  log?: (msg: string) => void;
}

export interface CronContext {
  /** 当前任务表（合并 yaml 声明 + 运行时 store）。 */
  list: () => CronTask[];
  stateStore: CronStateStore;
  /** 跑一条任务（已串行化，跑完自动推送）。给 /cron run、opennote run 用。 */
  runTask: (task: CronTask) => Promise<CronRunResult>;
  /** 起调度循环（跑到 abort）。 */
  startScheduler: (abortSignal: AbortSignal) => Promise<void>;
  /** 接给 handleSessionCommand 的 /cron 命令依赖。 */
  commandDeps: CronCommandDeps;
}

export function createCronContext(config: OpennoteConfig, opts: CronContextOpts = {}): CronContext {
  const sessionStore = opts.sessionStore ?? new SessionStore();
  const stateStore = new CronStateStore();
  const tasksStore = new TasksStore();
  const log = opts.log ?? ((m) => console.log(m));

  // 任务表 = yaml 声明的 + 运行时 store 建的，合并去名（store 覆盖）。调度、列表、触发口径一致。
  const list = (): CronTask[] => mergedTasks(config.cron, tasksStore);

  // 定时任务专用 agent：和消息通道隔离，避免并发踩 state.messages。
  const agent = createOpennoteAgent(config);
  const resolveKey = makeApiKeyResolver(config);
  const compaction: CompactionDeps = {
    model: agent.state.model,
    apiKey: resolveKey(agent.state.model.provider) ?? "",
    headers: config.agent.headers,
  };

  // 串行锁：调度器 tick 与 /cron run 共用这个 agent，得排队跑。
  const lock = new Mutex();
  const runTask = (task: CronTask): Promise<CronRunResult> =>
    lock.run(() =>
      runCronTask(task, {
        agent,
        sessionStore,
        compaction,
        push: opts.push,
        defaultTo: opts.defaultTo,
        log,
      }),
    );

  const commandDeps: CronCommandDeps = {
    list,
    stateStore,
    trigger(name) {
      const task = list().find((t) => t.name === name);
      if (!task) return false;
      // fire-and-forget：任务可能跑几分钟，别堵住命令所在的循环；锁保证不跟调度器抢 agent。
      void runTask(task).catch((err) =>
        log(`[cron] 手动触发「${name}」出错：${err instanceof Error ? err.message : err}`),
      );
      return true;
    },
    add(input) {
      try {
        const task = addUserTask(tasksStore, input, config.cron.map((t) => t.name));
        return { ok: true, task };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    remove(name) {
      if (tasksStore.remove(name)) return "removed";
      return config.cron.some((t) => t.name === name) ? "config" : "missing";
    },
    setEnabled(name, enabled) {
      if (tasksStore.setEnabled(name, enabled)) return "store";
      const cfgTask = config.cron.find((t) => t.name === name);
      if (cfgTask) {
        cfgTask.enabled = enabled; // 运行时改 config 对象，调度器下一 tick 即生效（重启回配置）
        return "config";
      }
      return "missing";
    },
  };

  return {
    list,
    stateStore,
    runTask,
    startScheduler: (abortSignal) =>
      runScheduler({ getTasks: list, stateStore, runTask: async (t) => void (await runTask(t)), abortSignal, log }),
    commandDeps,
  };
}
