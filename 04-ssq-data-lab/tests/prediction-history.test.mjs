import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// fake localStorage
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => { store.set(k, v); },
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const ph = await import("../assets/js/prediction-history.js");

beforeEach(() => store.clear());

test("record + list: 写入后能读出", () => {
  ph.record({ lottery: "ssq", targetIssue: "2026099", modelType: "test", topReds: [1, 2, 3, 4, 5, 6], topBlue: [7], K: { reds: 6, blue: 1 } });
  const r = ph.list("ssq");
  assert.equal(r.length, 1);
  assert.equal(r[0].lottery, "ssq");
  assert.equal(r[0].settled, false);
  assert.equal(r[0].redHit, null);
});

test("settle: 真号开奖后回填命中数", () => {
  ph.record({ lottery: "ssq", targetIssue: "2026099", modelType: "test", topReds: [1, 2, 3, 4, 5, 6], topBlue: [7], K: { reds: 6, blue: 1 } });
  ph.record({ lottery: "ssq", targetIssue: "2026100", modelType: "test", topReds: [10, 11, 12, 13, 14, 15], topBlue: [8], K: { reds: 6, blue: 1 } });

  const draws = [
    { issue: "2026099", reds: [1, 2, 3, 17, 19, 23], blue: 7 },  // 红中 3 + 蓝中
    { issue: "2026100", reds: [4, 5, 6, 7, 8, 9],   blue: 5 },   // 红 0 蓝 0
  ];
  const updated = ph.settle(draws, "ssq");
  assert.equal(updated, 2);
  const arr = ph.list("ssq");
  // list 是倒序：最新的（2026100）在前
  const r1 = arr.find((r) => r.targetIssue === "2026099");
  const r2 = arr.find((r) => r.targetIssue === "2026100");
  assert.equal(r1.redHit, 3);
  assert.equal(r1.blueHit, 1);
  assert.equal(r2.redHit, 0);
  assert.equal(r2.blueHit, 0);
});

test("summary: 统计平均命中数", () => {
  ph.record({ lottery: "ssq", targetIssue: "001", modelType: "t", topReds: [1, 2, 3, 4, 5, 6], topBlue: [7], K: { reds: 6, blue: 1 } });
  ph.record({ lottery: "ssq", targetIssue: "002", modelType: "t", topReds: [1, 2, 3, 4, 5, 6], topBlue: [7], K: { reds: 6, blue: 1 } });
  const draws = [
    { issue: "001", reds: [1, 2, 7, 8, 9, 10], blue: 7 },     // 红 2 蓝 1
    { issue: "002", reds: [4, 5, 6, 11, 12, 13], blue: 8 },   // 红 3 蓝 0
  ];
  ph.settle(draws, "ssq");
  const s = ph.summary("ssq", { redExp: 1.09, redVar: 0.5, blueExp: 0.0625, blueVar: 0.06 });
  assert.equal(s.totalSettled, 2);
  assert.equal(s.avgRedHit, 2.5);
  assert.equal(s.avgBlueHit, 0.5);
  assert.ok(s.redDist.length > 0);
});

test("clear: 按彩种清", () => {
  ph.record({ lottery: "ssq", targetIssue: "001", modelType: "t", topReds: [1], topBlue: [1], K: { reds: 1, blue: 1 } });
  ph.record({ lottery: "dlt", targetIssue: "002", modelType: "t", topReds: [1], topBlue: [1], K: { reds: 1, blue: 1 } });
  ph.clear("ssq");
  assert.equal(ph.list("ssq").length, 0);
  assert.equal(ph.list("dlt").length, 1);
});
