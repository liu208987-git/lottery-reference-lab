import { test } from "node:test";
import assert from "node:assert/strict";
import { stabilitySelection } from "../assets/js/stability-selection.js";

const fakeData = [];
for (let i = 0; i < 100; i++) {
  const reds = [];
  if (i % 3 !== 0) reds.push(1);
  if (i % 4 !== 0) reds.push(2);
  if (i % 5 !== 0) reds.push(3);
  let probe = 4;
  while (reds.length < 6 && probe <= 33) {
    if (!reds.includes(probe)) reds.push(probe);
    probe++;
  }
  fakeData.push({ reds: reds.slice(0, 6).sort((a, b) => a - b), blue: (i % 16) + 1 });
}

test("stabilitySelection: 高频号被反复选中", () => {
  const r = stabilitySelection({
    data: fakeData,
    N: 33,
    zoneKey: "reds",
    K: 6,
    B: 100,
    threshold: 0.5,
    seed: "stab-test",
  });
  // 高频号 1, 2, 3 应该出现频率高
  assert.ok(r.selectionFreq[1] > 0.5, `号 1 freq ${r.selectionFreq[1]}`);
  assert.ok(r.stableSet.includes(1));
  // 误发现率上界存在
  assert.ok(r.errorBound > 0);
  // 期望均匀基线
  assert.ok(Math.abs(r.expectedFreqUnderUniform - 6 / 33) < 1e-9);
});

test("stabilitySelection: 数据不足 → 空 stableSet", () => {
  const r = stabilitySelection({
    data: fakeData.slice(0, 10),
    N: 33, zoneKey: "reds", K: 6,
  });
  assert.equal(r.B, 0);
  assert.equal(r.stableSet.length, 0);
});

test("stabilitySelection: 自定义 scoreFn", () => {
  const r = stabilitySelection({
    data: fakeData,
    N: 33,
    zoneKey: "reds",
    K: 6,
    B: 50,
    scoreFn: () => {
      // 永远把 5 排第一
      const f = new Float32Array(34);
      f[5] = 100;
      return f;
    },
    seed: "stab-custom",
  });
  // 号 5 应该 100% 被选
  assert.equal(r.selectionFreq[5], 1);
});
