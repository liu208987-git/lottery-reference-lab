// 预测追踪：用户每次点"预测"时记录 timestamp + topK，等到那期开奖
// 自动比对真号，给出"你已做的 N 次预测，命中分布如下"。
//
// 这是项目的诚实立场最有力的体现：用真实持续追踪记录，验证"预测器
// 与基线统计上不可区分"的结论。
//
// 存储：localStorage（每条 100~200 字节，几百条够用）。
// 容量上限 1000 条；超过自动滚动删最早的。

const KEY = "lottery-prediction-history-v1";
const MAX_RECORDS = 1000;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(arr) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
    return true;
  } catch (e) {
    // localStorage 满 → 砍一半
    if (e.name === "QuotaExceededError" && arr.length > 10) {
      try {
        localStorage.setItem(KEY, JSON.stringify(arr.slice(-Math.floor(arr.length / 2))));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * 记录一次预测。
 * @param entry {
 *   lottery: "ssq" | "dlt",
 *   targetIssue: string,         // 这次预测的目标期号（约定是当前最新期+1，由 caller 决定）
 *   modelType: string,           // "lstm-single" | "lstm-ensemble" | "demo" | ...
 *   topReds: number[],           // SSQ topK 红 / DLT top 前
 *   topBlue: number[],           // SSQ top1 蓝（数组方便兼容） / DLT top 后
 *   K: { reds: number, blue: number }  // K 值，用于命中率
 * }
 */
export function record(entry) {
  const arr = load();
  arr.push({
    ...entry,
    createdAt: new Date().toISOString(),
    realReds: null,        // 等开奖后填
    realBlue: null,
    redHit: null,
    blueHit: null,
    settled: false,
  });
  // 滚动上限
  if (arr.length > MAX_RECORDS) arr.splice(0, arr.length - MAX_RECORDS);
  save(arr);
  return arr.length;
}

/**
 * 用最新 draws 数据回填命中：所有 unsettled 且 targetIssue 已开奖的，更新 realXxx + redHit/blueHit。
 * @param draws 排序好的 draws 数组（按 issue 升序），每条 { issue, reds/front, blue/back }
 * @param lottery "ssq" | "dlt"
 * @returns 更新的条数
 */
export function settle(draws, lottery) {
  if (!draws || draws.length === 0) return 0;
  const drawByIssue = new Map();
  for (const d of draws) drawByIssue.set(String(d.issue), d);

  const arr = load();
  let updated = 0;
  for (const rec of arr) {
    if (rec.settled) continue;
    if (rec.lottery !== lottery) continue;
    const real = drawByIssue.get(String(rec.targetIssue));
    if (!real) continue;
    const realReds = lottery === "ssq" ? real.reds : real.front;
    const realBlue = lottery === "ssq" ? [real.blue] : real.back;
    rec.realReds = realReds;
    rec.realBlue = realBlue;
    rec.redHit = (rec.topReds || []).filter((n) => realReds.includes(n)).length;
    rec.blueHit = (rec.topBlue || []).filter((n) => realBlue.includes(n)).length;
    rec.settled = true;
    updated++;
  }
  if (updated > 0) save(arr);
  return updated;
}

/** 列出某彩种的所有记录（最新在前）。 */
export function list(lottery) {
  return load().filter((r) => !lottery || r.lottery === lottery).reverse();
}

/** 清空（按彩种）。 */
export function clear(lottery) {
  if (!lottery) {
    save([]);
    return;
  }
  const arr = load().filter((r) => r.lottery !== lottery);
  save(arr);
}

/**
 * 汇总。返回 { totalSettled, avgRedHit, avgBlueHit, redDist: [{hit, count}], baseline: { redHitK, blueHitK } }
 * baseline 是该 K 在 i.i.d. 下的期望命中数（用于对比 "你做了 N 次，与随机一致 / 略好 / 略差"）。
 */
export function summary(lottery, baselines) {
  const recs = load().filter((r) => r.lottery === lottery && r.settled);
  if (recs.length === 0) {
    return { totalSettled: 0, totalUnsettled: list(lottery).length, recs: [] };
  }
  let sumRed = 0, sumBlue = 0;
  const redDist = new Map();
  const blueDist = new Map();
  for (const r of recs) {
    sumRed += r.redHit ?? 0;
    sumBlue += r.blueHit ?? 0;
    redDist.set(r.redHit, (redDist.get(r.redHit) || 0) + 1);
    blueDist.set(r.blueHit, (blueDist.get(r.blueHit) || 0) + 1);
  }
  const n = recs.length;
  const avgRedHit = sumRed / n;
  const avgBlueHit = sumBlue / n;

  // 双样本 binomial：N 次 hit 数和 vs 期望均值，给一个粗略 z-score
  const zScore = (avgObs, avgExp, varPerSample, n_) => {
    if (n_ < 5 || varPerSample <= 0) return null;
    return (avgObs - avgExp) * Math.sqrt(n_) / Math.sqrt(varPerSample);
  };

  const totalUnsettled = list(lottery).filter((r) => !r.settled).length;

  // 取第一条的 K（假设用户用的 K 一致；不一致就提示用户）
  const Ks = new Set(recs.map((r) => `${r.K?.reds ?? "?"}-${r.K?.blue ?? "?"}`));
  const consistentK = Ks.size === 1 ? Array.from(Ks)[0] : "mixed";

  return {
    totalSettled: n,
    totalUnsettled,
    avgRedHit, avgBlueHit,
    sumRed, sumBlue,
    redDist: Array.from(redDist.entries()).map(([hit, count]) => ({ hit, count })).sort((a, b) => a.hit - b.hit),
    blueDist: Array.from(blueDist.entries()).map(([hit, count]) => ({ hit, count })).sort((a, b) => a.hit - b.hit),
    consistentK,
    // baseline 由 caller 传入
    baseline: baselines || null,
    zRed: baselines?.redExp != null ? zScore(avgRedHit, baselines.redExp, baselines.redVar ?? 0.5, n) : null,
    zBlue: baselines?.blueExp != null ? zScore(avgBlueHit, baselines.blueExp, baselines.blueVar ?? 0.05, n) : null,
  };
}
