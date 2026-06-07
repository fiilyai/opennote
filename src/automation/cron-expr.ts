/**
 * 极简 cron 表达式解析 + 匹配（Day 8）。
 *
 * 只做调度需要的那点事，不引第三方 cron 库——5 个字段、人话能读懂的几种写法，
 * 足够覆盖「每天几点」「每隔几分钟」「每周几」这些日常排程。
 *
 *   ┌── 分钟 0-59
 *   │ ┌── 小时 0-23
 *   │ │ ┌── 日 1-31
 *   │ │ │ ┌── 月 1-12
 *   │ │ │ │ ┌── 周几 0-6（0=周日，也认 7=周日）
 *   * * * * *
 *
 * 每个字段支持：`*`、单个数字、`a-b` 范围、`a,b,c` 列表、`* /n` 步长、`a-b/n` 范围步长。
 * 匹配按**本地时区**（笔记/日报是给本地的人看的，别用 UTC——Day 6 踩过这个坑）。
 */

const FIELD_RANGES = [
  { name: "分钟", min: 0, max: 59 },
  { name: "小时", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "周", min: 0, max: 7 }, // 7 也当周日，解析后归一到 0
] as const;

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>; // day of month
  month: Set<number>;
  dow: Set<number>; // day of week (0=Sun)
  /** 日 / 周 是否都被限定（非 `*`）——决定它俩是「与」还是「或」（见 cronMatches）。 */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** 解析单个字段（如 `*\/15`、`1-5`、`0,30`）成命中值集合。非法写法抛错。 */
function parseField(spec: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`${label} 字段有空项：${spec}`);

    // 拆步长：body[/step]
    const [body, stepRaw] = piece.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`${label} 步长非法：${piece}`);
    }

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body!.includes("-")) {
      const [a, b] = body!.split("-").map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = Number(body);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`${label} 取值越界（应在 ${min}-${max}）：${piece}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 解析整条 cron 表达式。字段数不对或某字段非法都抛错。 */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式应为 5 个字段（分 时 日 月 周），收到 ${parts.length} 个：${expr}`);
  }
  const sets = parts.map((p, i) =>
    parseField(p, FIELD_RANGES[i]!.min, FIELD_RANGES[i]!.max, FIELD_RANGES[i]!.name),
  );

  // 周字段把 7 归一成 0（两者都表示周日）。
  const dow = new Set<number>();
  for (const v of sets[4]!) dow.add(v === 7 ? 0 : v);

  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/**
 * 某个时刻是否命中这条 cron（按本地时区取分/时/日/月/周）。
 *
 * 日(dom) 与 周(dow) 的经典歧义：两者都限定时取「或」——只要命中其一就算
 * （标准 Vixie cron 行为，如 `0 0 1 * 1` = 每月 1 号「或」每周一）。其余字段一律「与」。
 */
export function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;

  const domHit = f.dom.has(d.getDate());
  const dowHit = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domHit || dowHit;
  if (f.domRestricted) return domHit;
  if (f.dowRestricted) return dowHit;
  return true; // 日、周都是 *
}
