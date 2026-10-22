// 大乐透号码深度体检解释器
//
// 输入：一注前区 5 + 后区 2
// 输出：多维度评分 + 一句话理由 + 红/黄/绿"健康灯"
//
// 设计哲学：
//   - 不预测中奖（彩票是 i.i.d.，谁也不能预测）
//   - 但可以诊断这一注是否"过于拥挤"——降低撞号风险
//   - 评分为 SHAP-like 加性归因：每个维度独立打分，相加得到总分
//   - 总分 60-100 健康 / 30-60 注意 / 0-30 警告
//
// 评估维度（百分制，越高越健康）：
//   1. 分布散度（zone, 大小, 奇偶）—— 偏离极端 → 高分
//   2. AC 值（号码差异性）        —— 越分散越高
//   3. 历史频率反转（避免全冷/全热） —— 频率方差小 → 高分
//   4. 撞号风险（生日号、连号、同尾、等差） —— 越少 → 高分
//   5. 同期重复（与最近一期重叠数） —— 重叠少 → 高分
//   6. 数据稀缺度（这种型态历史出现次数）  —— 中位数附近 → 高分

import {
  frontSum, frontSpan, frontOddCount,
  frontOddEvenRatio, frontBigSmallRatio, frontZoneRatio,
  frontAcValue, frontConsecutiveGroups, frontMaxSameTail,
  backSum, backOddEvenRatio,
  FRONT_PICK,
} from "./dlt-distribution.js";

/** 主入口：返回完整诊断报告。 */
export function diagnoseTicket({ front, back }, history = []) {
  const sortedFront = [...front].sort((a, b) => a - b);
  const sortedBack = [...back].sort((a, b) => a - b);

  const features = extractFeatures(sortedFront, sortedBack);
  const dimensions = [
    scoreDistributionEntropy(sortedFront, features),
    scoreAcDispersion(features),
    scoreFrequencyBalance(sortedFront, history),
    scoreCrowdRisk(sortedFront, sortedBack, features),
    scoreRecentOverlap(sortedFront, sortedBack, history),
    scorePatternRarity(sortedFront, history),
  ];
  const totalScore = dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length;

  return {
    front: sortedFront,
    back: sortedBack,
    totalScore: Math.round(totalScore),
    healthLevel: healthLevel(totalScore),
    dimensions,
    features,
    advice: generateAdvice(dimensions, features),
  };
}

function healthLevel(score) {
  if (score >= 75) return { label: "健康", color: "green", emoji: "✅" };
  if (score >= 50) return { label: "中等", color: "amber", emoji: "⚠️" };
  return { label: "高风险", color: "red", emoji: "🚨" };
}

function extractFeatures(front, back) {
  const sum = frontSum(front);
  const span = frontSpan(front);
  const odd = frontOddCount(front);
  const big = front.filter((n) => n >= 18).length;
  const zoneStr = frontZoneRatio(front);
  const ac = frontAcValue(front);
  const consec = frontConsecutiveGroups(front);
  const tailMax = frontMaxSameTail(front);
  const birthdayCount = front.filter((n) => n <= 31).length;
  const smallDateCount = front.filter((n) => n <= 12).length;
  return {
    sum, span, odd, big, zoneStr, ac, consec, tailMax,
    birthdayCount, smallDateCount,
    backSum: backSum(back),
    backOdd: back.filter((x) => x % 2 === 1).length,
  };
}

/* =========================================================
 * 维度 1：分布散度（zone / 大小 / 奇偶）
 * ========================================================= */
function scoreDistributionEntropy(front, f) {
  let score = 100;
  const reasons = [];

  // 三区比：极端 (5:0:0 / 0:5:0 / 0:0:5) 严重扣分
  const zone = f.zoneStr.split(":").map(Number);
  const maxZone = Math.max(...zone);
  if (maxZone === FRONT_PICK) { score -= 40; reasons.push("5 个号集中在同一区"); }
  else if (maxZone === FRONT_PICK - 1) { score -= 15; reasons.push("4 个号集中在同一区"); }
  // 三区都覆盖到 → 加分
  else if (zone.every((z) => z > 0)) reasons.push("三区均覆盖（理想）");

  // 奇偶：全奇/全偶
  if (f.odd === 0 || f.odd === FRONT_PICK) { score -= 25; reasons.push(`奇偶 ${f.odd}:${FRONT_PICK - f.odd} 极端`); }
  else if (f.odd === 1 || f.odd === FRONT_PICK - 1) { score -= 8; reasons.push(`奇偶 ${f.odd}:${FRONT_PICK - f.odd} 偏极端`); }

  // 大小：以 18 为阈值
  if (f.big === 0) { score -= 18; reasons.push("全部小号 (≤17)"); }
  else if (f.big === FRONT_PICK) { score -= 18; reasons.push("全部大号 (≥18)"); }

  return {
    name: "分布散度",
    score: Math.max(0, score),
    weight: 1,
    icon: "🌐",
    reasons: reasons.length ? reasons : ["分布合理"],
  };
}

/* =========================================================
 * 维度 2：AC 值（号码两两差的多样性）
 * ========================================================= */
function scoreAcDispersion(f) {
  // AC 值 0..6（k=5 时最大 C(5,2)-4=6）
  const reasons = [];
  let score = 100;
  if (f.ac === 0) { score -= 60; reasons.push("AC=0：号码完全等差"); }
  else if (f.ac <= 2) { score -= 30; reasons.push(`AC=${f.ac}：差异不足`); }
  else if (f.ac >= 5) reasons.push(`AC=${f.ac}：号码高度分散（理想）`);
  else reasons.push(`AC=${f.ac}：分散度中等`);
  if (f.consec >= 3) { score -= 20; reasons.push(`${f.consec} 组连号`); }
  else if (f.consec === 2) { score -= 10; reasons.push("2 组连号"); }
  return {
    name: "号码多样性",
    score: Math.max(0, score),
    weight: 1,
    icon: "🔀",
    reasons,
  };
}

/* =========================================================
 * 维度 3：历史频率平衡（避免全选历史最热/最冷）
 * ========================================================= */
function scoreFrequencyBalance(front, history) {
  if (history.length === 0) return placeholder("历史频率", "数据不足");
  const freq = Array(36).fill(0);
  for (const d of history) for (const n of d.front) freq[n]++;
  const ranks = front.map((n) => {
    const rank = Array.from({ length: 35 }, (_, i) => [i + 1, freq[i + 1]])
      .sort((a, b) => b[1] - a[1])
      .findIndex(([num]) => num === n) + 1;
    return rank;
  });
  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  // 理想 avgRank ≈ 18（中位）
  const dev = Math.abs(avgRank - 18);
  let score = 100 - dev * 4;
  const reasons = [];
  if (avgRank <= 8) reasons.push(`历史频率排名均值 ${avgRank.toFixed(1)} 名（偏热门）`);
  else if (avgRank >= 28) reasons.push(`历史频率排名均值 ${avgRank.toFixed(1)} 名（偏冷门）`);
  else reasons.push(`历史频率排名均值 ${avgRank.toFixed(1)} 名（均衡）`);
  return {
    name: "热度均衡",
    score: Math.max(0, Math.min(100, score)),
    weight: 1,
    icon: "🌡️",
    reasons,
  };
}

/* =========================================================
 * 维度 4：撞号风险（生日号、连号、同尾、特殊后区）
 * ========================================================= */
function scoreCrowdRisk(front, back, f) {
  let score = 100;
  const reasons = [];
  if (f.birthdayCount === FRONT_PICK) { score -= 30; reasons.push("全部 ≤31（生日号高撞）"); }
  if (f.smallDateCount >= 4) { score -= 15; reasons.push(`${f.smallDateCount} 个 ≤12（月份号高撞）`); }
  if (f.tailMax >= 3) { score -= 10 * (f.tailMax - 2); reasons.push(`同尾 ${f.tailMax} 个`); }
  if (f.consec >= 2) { score -= 5 * f.consec; reasons.push(`${f.consec} 组连号`); }
  // 后区 "01 02"、"11 12" 这种紧邻最容易撞
  if (back[1] - back[0] === 1) { score -= 8; reasons.push("后区紧邻"); }
  // 后区双 7、双 12、生日二人组
  if (back.includes(7) && back.includes(12)) { score -= 5; reasons.push("后区 07+12 老彩民经典组合"); }
  if (reasons.length === 0) reasons.push("撞号风险低");
  return {
    name: "撞号风险",
    score: Math.max(0, score),
    weight: 1,
    icon: "👥",
    reasons,
  };
}

/* =========================================================
 * 维度 5：与最近一期重叠
 * ========================================================= */
function scoreRecentOverlap(front, back, history) {
  if (history.length === 0) return placeholder("与上期重叠", "数据不足");
  const last = history[history.length - 1];
  const fOverlap = front.filter((n) => last.front.includes(n)).length;
  const bOverlap = back.filter((n) => last.back.includes(n)).length;
  let score = 100;
  if (fOverlap >= 3) score -= 30;
  else if (fOverlap === 2) score -= 10;
  else if (fOverlap === 1) score -= 3;
  if (bOverlap === 2) score -= 15;
  else if (bOverlap === 1) score -= 5;
  const reasons = [];
  reasons.push(`与上期前区重叠 ${fOverlap}，后区重叠 ${bOverlap}`);
  if (fOverlap === 0 && bOverlap === 0) reasons.push("与上期完全错开（推荐）");
  return {
    name: "与上期错开",
    score: Math.max(0, score),
    weight: 1,
    icon: "🆕",
    reasons,
  };
}

/* =========================================================
 * 维度 6：型态稀缺度（不能太罕见也不能太常见）
 * ========================================================= */
function scorePatternRarity(front, history) {
  if (history.length < 100) return placeholder("型态稀缺度", "数据不足");
  // 用 (奇数个数, 跨度区间, 三区比) 作为型态指纹
  const fp = patternFingerprint(front);
  const counter = new Map();
  for (const d of history) {
    const k = patternFingerprint(d.front);
    counter.set(k, (counter.get(k) || 0) + 1);
  }
  const cnt = counter.get(fp) || 0;
  const expected = history.length / counter.size;
  // 越接近期望频次越合理
  const ratio = cnt / expected;
  let score;
  if (ratio === 0) score = 0;
  else if (ratio >= 0.5 && ratio <= 2) score = 100;
  else if (ratio >= 0.2 && ratio <= 5) score = 70;
  else score = 40;
  return {
    name: "型态合理性",
    score,
    weight: 1,
    icon: "📐",
    reasons: [`这种型态历史出现 ${cnt} 次（期望 ${expected.toFixed(1)} 次）`],
  };
}

function patternFingerprint(front) {
  const odd = front.filter((x) => x % 2 === 1).length;
  const span = Math.max(...front) - Math.min(...front);
  const spanBucket = span < 14 ? "tight" : span < 22 ? "mid" : "wide";
  const z = [0, 0, 0];
  for (const r of front) z[r <= 12 ? 0 : r <= 24 ? 1 : 2]++;
  return `${odd}|${spanBucket}|${z.join(",")}`;
}

function placeholder(name, msg) {
  return { name, score: 70, weight: 0.5, icon: "—", reasons: [msg] };
}

/* =========================================================
 * 综合建议
 * ========================================================= */
function generateAdvice(dimensions, f) {
  const lows = dimensions.filter((d) => d.score < 50).sort((a, b) => a.score - b.score);
  if (lows.length === 0) {
    return "整体健康。这一注分布合理、撞号风险低、与历史型态契合。**这不代表更可能中奖**，但在中奖时不容易和别人重号。";
  }
  const items = lows.slice(0, 2).map((d) => `${d.icon} ${d.name}（${d.score} 分）：${d.reasons[0]}`);
  return `⚠️ 主要薄弱项：\n${items.join("\n")}\n\n建议替换其中 1-2 个号以改善上述维度。再次提醒：这只关乎"分散覆盖"，不影响中奖概率本身。`;
}
