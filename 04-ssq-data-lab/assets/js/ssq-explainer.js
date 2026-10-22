// 双色球号码深度体检解释器（与 dlt-explainer.js 同构）
//
// 输入：一注 6 红 + 1 蓝
// 输出：六维度评分 + 一句话理由 + 健康灯
//
// 设计哲学完全一致：不预测中奖，但诊断"撞号 / 拥挤度"。
// 评分越高越健康，建议替换薄弱号。

import {
  oddEvenRatio, bigSmallRatio, primeCompositeRatio,
  zoneRatio, acValue, consecutiveGroups, maxSameTail,
} from "./distribution.js";

const REDS_PICK = 6;

/** 主入口：返回完整诊断报告。 */
export function diagnoseSsqTicket({ reds, blue }, history = []) {
  const sortedReds = [...reds].sort((a, b) => a - b);
  const features = extractFeatures(sortedReds, blue);
  const dimensions = [
    scoreDistributionEntropy(sortedReds, features),
    scoreAcDispersion(features),
    scoreFrequencyBalance(sortedReds, history),
    scoreCrowdRisk(sortedReds, blue, features),
    scoreRecentOverlap(sortedReds, blue, history),
    scorePatternRarity(sortedReds, history),
  ];
  const totalScore = dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length;
  return {
    reds: sortedReds, blue,
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

function extractFeatures(reds, blue) {
  const sum = reds.reduce((a, b) => a + b, 0);
  const span = Math.max(...reds) - Math.min(...reds);
  const odd = reds.filter((n) => n % 2 === 1).length;
  const big = reds.filter((n) => n >= 17).length;
  const zoneStr = zoneRatio(reds);
  const ac = acValue(reds);
  const consec = consecutiveGroups(reds);
  const tailMax = maxSameTail(reds);
  const birthdayCount = reds.filter((n) => n <= 31).length;
  const smallDateCount = reds.filter((n) => n <= 12).length;
  return {
    sum, span, odd, big, zoneStr, ac, consec, tailMax,
    birthdayCount, smallDateCount,
    blue,
    blueIsBirthday: blue <= 16,  // 蓝球本来就 1-16，永远是
    blueIsSmall: blue <= 8,
  };
}

/* 维度 1：分布散度 */
function scoreDistributionEntropy(reds, f) {
  let score = 100;
  const reasons = [];
  const zone = f.zoneStr.split(":").map(Number);
  const maxZone = Math.max(...zone);
  if (maxZone === REDS_PICK) { score -= 40; reasons.push("6 个号集中在同一区"); }
  else if (maxZone === REDS_PICK - 1) { score -= 15; reasons.push("5 个号集中在同一区"); }
  else if (zone.every((z) => z > 0)) reasons.push("三区均覆盖（理想）");

  if (f.odd === 0 || f.odd === REDS_PICK) { score -= 25; reasons.push(`奇偶 ${f.odd}:${REDS_PICK - f.odd} 极端`); }
  else if (f.odd === 1 || f.odd === REDS_PICK - 1) { score -= 8; reasons.push(`奇偶 ${f.odd}:${REDS_PICK - f.odd} 偏极端`); }

  if (f.big === 0) { score -= 18; reasons.push("全部小号 (≤16)"); }
  else if (f.big === REDS_PICK) { score -= 18; reasons.push("全部大号 (≥17)"); }

  return {
    name: "分布散度", score: Math.max(0, score), weight: 1,
    icon: "🌐", reasons: reasons.length ? reasons : ["分布合理"],
  };
}

/* 维度 2：AC 值 */
function scoreAcDispersion(f) {
  // SSQ AC 值范围 0..10（k=6 → C(6,2)-5=10）
  const reasons = [];
  let score = 100;
  if (f.ac === 0) { score -= 60; reasons.push("AC=0：号码完全等差"); }
  else if (f.ac <= 3) { score -= 30; reasons.push(`AC=${f.ac}：差异不足`); }
  else if (f.ac >= 7) reasons.push(`AC=${f.ac}：号码高度分散（理想）`);
  else reasons.push(`AC=${f.ac}：分散度中等`);
  if (f.consec >= 3) { score -= 20; reasons.push(`${f.consec} 组连号`); }
  else if (f.consec === 2) { score -= 10; reasons.push("2 组连号"); }
  return { name: "号码多样性", score: Math.max(0, score), weight: 1, icon: "🔀", reasons };
}

/* 维度 3：历史频率平衡 */
function scoreFrequencyBalance(reds, history) {
  if (history.length === 0) return placeholder("历史频率", "数据不足");
  const freq = Array(34).fill(0);
  for (const d of history) for (const n of d.reds) freq[n]++;
  const ranks = reds.map((n) => {
    return Array.from({ length: 33 }, (_, i) => [i + 1, freq[i + 1]])
      .sort((a, b) => b[1] - a[1])
      .findIndex(([num]) => num === n) + 1;
  });
  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  // 理想 avgRank ≈ 17 (中位)
  const dev = Math.abs(avgRank - 17);
  let score = 100 - dev * 4.2;
  const reasons = [];
  if (avgRank <= 8) reasons.push(`历史频率排名均值 ${avgRank.toFixed(1)} 名（偏热门）`);
  else if (avgRank >= 26) reasons.push(`历史频率排名均值 ${avgRank.toFixed(1)} 名（偏冷门）`);
  else reasons.push(`历史频率排名均值 ${avgRank.toFixed(1)} 名（均衡）`);
  return { name: "热度均衡", score: Math.max(0, Math.min(100, score)), weight: 1, icon: "🌡️", reasons };
}

/* 维度 4：撞号风险 */
function scoreCrowdRisk(reds, blue, f) {
  let score = 100;
  const reasons = [];
  if (f.birthdayCount === REDS_PICK) { score -= 30; reasons.push("全部 ≤31（生日号高撞）"); }
  if (f.smallDateCount >= 5) { score -= 15; reasons.push(`${f.smallDateCount} 个 ≤12（月份号高撞）`); }
  if (f.tailMax >= 3) { score -= 10 * (f.tailMax - 2); reasons.push(`同尾 ${f.tailMax} 个`); }
  if (f.consec >= 2) { score -= 5 * f.consec; reasons.push(`${f.consec} 组连号`); }
  if (blue <= 16 && blue >= 1) {  // 蓝球永远在
    if (f.blueIsSmall) reasons.push("蓝球 ≤8（生日数高撞）");
  }
  if (reasons.length === 0) reasons.push("撞号风险低");
  return { name: "撞号风险", score: Math.max(0, score), weight: 1, icon: "👥", reasons };
}

/* 维度 5：与最近一期重叠 */
function scoreRecentOverlap(reds, blue, history) {
  if (history.length === 0) return placeholder("与上期重叠", "数据不足");
  const last = history[history.length - 1];
  const overlap = reds.filter((n) => last.reds.includes(n)).length;
  const blueSame = blue === last.blue;
  let score = 100;
  if (overlap >= 3) score -= 30;
  else if (overlap === 2) score -= 10;
  else if (overlap === 1) score -= 3;
  if (blueSame) score -= 12;
  const reasons = [`与上期红球重叠 ${overlap}${blueSame ? "，蓝球相同" : ""}`];
  if (overlap === 0 && !blueSame) reasons.push("与上期完全错开（推荐）");
  return { name: "与上期错开", score: Math.max(0, score), weight: 1, icon: "🆕", reasons };
}

/* 维度 6：型态稀缺度 */
function scorePatternRarity(reds, history) {
  if (history.length < 100) return placeholder("型态稀缺度", "数据不足");
  const fp = patternFingerprint(reds);
  const counter = new Map();
  for (const d of history) {
    const k = patternFingerprint(d.reds);
    counter.set(k, (counter.get(k) || 0) + 1);
  }
  const cnt = counter.get(fp) || 0;
  const expected = history.length / counter.size;
  const ratio = cnt / expected;
  let score;
  if (ratio === 0) score = 0;
  else if (ratio >= 0.5 && ratio <= 2) score = 100;
  else if (ratio >= 0.2 && ratio <= 5) score = 70;
  else score = 40;
  return {
    name: "型态合理性", score, weight: 1, icon: "📐",
    reasons: [`这种型态历史出现 ${cnt} 次（期望 ${expected.toFixed(1)} 次）`],
  };
}

function patternFingerprint(reds) {
  const odd = reds.filter((x) => x % 2 === 1).length;
  const span = Math.max(...reds) - Math.min(...reds);
  const spanBucket = span < 14 ? "tight" : span < 22 ? "mid" : "wide";
  const z = [0, 0, 0];
  for (const r of reds) z[r <= 11 ? 0 : r <= 22 ? 1 : 2]++;
  return `${odd}|${spanBucket}|${z.join(",")}`;
}

function placeholder(name, msg) {
  return { name, score: 70, weight: 0.5, icon: "—", reasons: [msg] };
}

function generateAdvice(dimensions, f) {
  const lows = dimensions.filter((d) => d.score < 50).sort((a, b) => a.score - b.score);
  if (lows.length === 0) {
    return "整体健康。这一注分布合理、撞号风险低、与历史型态契合。**这不代表更可能中奖**，但在中奖时不容易和别人重号。";
  }
  const items = lows.slice(0, 2).map((d) => `${d.icon} ${d.name}（${d.score} 分）：${d.reasons[0]}`);
  return `⚠️ 主要薄弱项：\n${items.join("\n")}\n\n建议替换其中 1-2 个号以改善上述维度。再次提醒：这只关乎"分散覆盖"，不影响中奖概率本身。`;
}
