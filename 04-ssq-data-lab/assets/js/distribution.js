// 分布分析：把一期开奖抽象成一组标签（奇偶比、大小比、012路、质合比、和值、跨度、AC 值、分区比）
// 然后统计历史数据在这些标签上的分布。

export function isPrime(n) {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

export function oddEvenRatio(reds) {
  const odd = reds.filter((x) => x % 2 === 1).length;
  return `${odd}:${6 - odd}`;
}

export function bigSmallRatio(reds, threshold = 16) {
  const big = reds.filter((x) => x > threshold).length;
  return `${big}:${6 - big}`;
}

export function primeCompositeRatio(reds) {
  const primes = reds.filter(isPrime).length;
  return `${primes}:${6 - primes}`;
}

export function path012Ratio(reds) {
  // 012 路：number % 3
  const counts = [0, 0, 0];
  for (const r of reds) counts[r % 3]++;
  return counts.join(":");
}

export function zoneRatio(reds) {
  const z = [0, 0, 0];
  for (const r of reds) z[r <= 11 ? 0 : r <= 22 ? 1 : 2]++;
  return z.join(":");
}

// AC 值：6 个数两两之差的绝对值集合的大小 - 5
// 反映号码离散度，范围 0-10，AC 值越大号码越"散"
export function acValue(reds) {
  const diffs = new Set();
  for (let i = 0; i < reds.length; i++) {
    for (let j = i + 1; j < reds.length; j++) {
      diffs.add(Math.abs(reds[i] - reds[j]));
    }
  }
  return diffs.size - (reds.length - 1);
}

// 连号数量（至少 2 个连续的算 1 组）
export function consecutiveGroups(reds) {
  const sorted = [...reds].sort((a, b) => a - b);
  let groups = 0;
  let inGroup = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      if (!inGroup) groups++;
      inGroup = true;
    } else {
      inGroup = false;
    }
  }
  return groups;
}

// 同尾号（个位相同）最大出现次数
export function maxSameTail(reds) {
  const tails = Array(10).fill(0);
  for (const r of reds) tails[r % 10]++;
  return Math.max(...tails);
}

// 把一组历史数据按某个特征分桶 -> { bucket: count }
export function groupBy(draws, fn) {
  const map = new Map();
  for (const d of draws) {
    const k = fn(d.reds, d.blue);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => {
    // 先按频次降序，再按 key 升序
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]), "zh", { numeric: true });
  });
}

// 返回和值、跨度、AC 值的直方图（按整数值分桶）
export function histogram(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) || 0) + 1);
  const keys = [...map.keys()].sort((a, b) => a - b);
  return keys.map((k) => [k, map.get(k)]);
}
