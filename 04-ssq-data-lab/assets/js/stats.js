export const RED_MAX = 33;
export const BLUE_MAX = 16;

export function freqFromDraws(draws, field, size) {
  const f = Array(size + 1).fill(0);
  for (const d of draws) {
    if (field === "reds") {
      for (const r of d.reds) f[r] += 1;
    } else if (field === "blue") {
      f[d.blue] += 1;
    }
  }
  return f;
}

export function missCounts(draws, field, size) {
  const lastSeen = Array(size + 1).fill(null);
  const lastIndex = draws.length - 1;
  for (let i = lastIndex; i >= 0; i--) {
    const d = draws[i];
    if (field === "reds") {
      for (const r of d.reds) {
        if (lastSeen[r] == null) lastSeen[r] = i;
      }
    } else if (field === "blue") {
      if (lastSeen[d.blue] == null) lastSeen[d.blue] = i;
    }
  }
  const miss = Array(size + 1).fill(0);
  for (let n = 1; n <= size; n++) {
    miss[n] = lastSeen[n] == null ? draws.length : lastIndex - lastSeen[n];
  }
  return miss;
}

export function topN(freq, n, size) {
  const pairs = [];
  for (let i = 1; i <= size; i++) pairs.push([i, freq[i]]);
  pairs.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pairs.slice(0, n);
}

export function bottomN(freq, n, size) {
  const pairs = [];
  for (let i = 1; i <= size; i++) pairs.push([i, freq[i]]);
  pairs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return pairs.slice(0, n);
}

export const zoneIndex = (n) => (n <= 11 ? 0 : n <= 22 ? 1 : 2);

export function zoneCounts(reds) {
  const z = [0, 0, 0];
  for (const r of reds) z[zoneIndex(r)]++;
  return z;
}

export const spanOf = (reds) => Math.max(...reds) - Math.min(...reds);
export const sumOf = (reds) => reds.reduce((a, b) => a + b, 0);
export const oddCountOf = (reds) => reds.filter((x) => x % 2 === 1).length;

export function acValueOf(reds) {
  const diffs = new Set();
  for (let i = 0; i < reds.length; i++) {
    for (let j = i + 1; j < reds.length; j++) {
      diffs.add(Math.abs(reds[i] - reds[j]));
    }
  }
  return diffs.size - (reds.length - 1);
}

export function consecutiveGroupsOf(reds) {
  const sorted = [...reds].sort((a, b) => a - b);
  let groups = 0;
  let inRun = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      if (!inRun) groups++;
      inRun = true;
    } else {
      inRun = false;
    }
  }
  return groups;
}

export function passesConstraints(reds, c) {
  if (c.sum && (sumOf(reds) < 70 || sumOf(reds) > 150)) return false;
  if (c.odd) {
    const oc = oddCountOf(reds);
    if (oc < 2 || oc > 4) return false;
  }
  if (c.span && spanOf(reds) < 18) return false;
  if (c.zone && Math.max(...zoneCounts(reds)) > 4) return false;
  if (c.ac && acValueOf(reds) < 7) return false;
  if (c.noConsec && consecutiveGroupsOf(reds) > 1) return false;
  return true;
}

export function analyseConstraintFailures(reds, c) {
  const reasons = [];
  if (c.sum) {
    const s = sumOf(reds);
    if (s < 70 || s > 150) reasons.push(`和值 ${s} 不在 70-150`);
  }
  if (c.odd) {
    const oc = oddCountOf(reds);
    if (oc < 2 || oc > 4) reasons.push(`奇数 ${oc} 不在 2-4`);
  }
  if (c.span && spanOf(reds) < 18) reasons.push(`跨度 ${spanOf(reds)} < 18`);
  if (c.zone && Math.max(...zoneCounts(reds)) > 4) reasons.push("单区超 4 个");
  if (c.ac && acValueOf(reds) < 7) reasons.push(`AC 值 ${acValueOf(reds)} < 7`);
  if (c.noConsec && consecutiveGroupsOf(reds) > 1) reasons.push(`连号组 ${consecutiveGroupsOf(reds)} > 1`);
  return reasons;
}
