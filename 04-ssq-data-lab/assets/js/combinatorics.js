// 胆拖号码试算：C(n, k) 组合数
export function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < k; i++) {
    c = (c * (n - i)) / (i + 1);
  }
  return Math.round(c);
}

// 胆拖注数：选了 dan 个胆码（<=5） + tuo 个拖码（>=6-dan），篮球 blueCount 个
// 红球组合数 = C(tuo, 6 - dan)；总注数 = 红球组合数 × 蓝球数
export function danTuoTickets({ danCount, tuoCount, blueCount }) {
  if (danCount < 0 || danCount > 5) throw new Error("胆码数量 0-5");
  if (tuoCount < 6 - danCount) throw new Error(`拖码至少 ${6 - danCount} 个`);
  if (danCount + tuoCount > 33) throw new Error("红球总数不能超过 33");
  if (blueCount < 1 || blueCount > 16) throw new Error("蓝球 1-16 个");
  const redTickets = combinations(tuoCount, 6 - danCount);
  return redTickets * blueCount;
}

// 复式注数：选 m 个红球（≥6），n 个蓝球（≥1）
export function complexTickets(redCount, blueCount) {
  return combinations(redCount, 6) * blueCount;
}

// 总金额：每注 2 元
export function priceOf(tickets) {
  return tickets * 2;
}
