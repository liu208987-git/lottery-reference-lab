// 基本走势图：生成散点位置；每期是一行，每个号码占一列
// 返回 { issues, rows: Array<{issue, date, marks: Set<number>, blue }> }

export function buildTrendMatrix(draws, windowSize = 30) {
  const slice = draws.slice(-windowSize);
  return slice.map((d) => ({
    issue: d.issue,
    date: d.date,
    reds: new Set(d.reds),
    blue: d.blue,
  }));
}

// 计算某号码在窗口内的"最长连续未出"与"最长连续出现"
export function streaks(draws, num, field = "reds") {
  let curMiss = 0, maxMiss = 0, curHit = 0, maxHit = 0;
  for (const d of draws) {
    const hit = field === "reds" ? d.reds.includes(num) : d.blue === num;
    if (hit) {
      curHit++;
      maxHit = Math.max(maxHit, curHit);
      curMiss = 0;
    } else {
      curMiss++;
      maxMiss = Math.max(maxMiss, curMiss);
      curHit = 0;
    }
  }
  return { maxMiss, maxHit };
}
