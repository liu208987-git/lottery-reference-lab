import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("root page exposes a first-class DLT entry point", () => {
  const html = read("index.html");
  assert.match(html, /class="lottery-switcher"/);
  assert.match(html, /href="\.\/dlt\.html"/);
  assert.match(html, /大乐透/);
  assert.match(html, /assets\/dlt-styles\.css/);
});

test("DLT backtest module is available to the PWA cache", () => {
  const sw = read("sw.js");

  assert.match(sw, /assets\/js\/dlt-backtest\.js/);
});

test("DLT page is wired to DLT data, styles, and controller", () => {
  const page = join(ROOT, "dlt.html");
  assert.ok(existsSync(page), "dlt.html should exist");
  const html = read("dlt.html");

  assert.match(html, /<title>大乐透数据实验室 · DLT Data Lab<\/title>/);
  assert.match(html, /data\/dlt-draws\.js/);
  assert.match(html, /assets\/js\/dlt-main\.js/);
  assert.match(html, /assets\/dlt-styles\.css/);
  assert.match(html, /data-lottery="dlt"/);
  // 大乐透自己的 LSTM tab + 控件 id 都用 dlt 前缀
  assert.match(html, /data-tab="lstm"/);
  assert.match(html, /id="btnDltLstmTrain"/);
});

test("DLT page contains the expected analytical workbench DOM hooks", () => {
  const html = read("dlt.html");
  const requiredIds = [
    "chartFrontAll",
    "chartBackAll",
    "trendFront",
    "trendBack",
    "distBackOddEven",
    "chartBackSum",
    "strategyFront",
    "strategyBack",
    "includeFront",
    "includeBack",
    "manualFront",
    "manualBack",
    "backtestRounds",
    "backtestMethod",
    "backtestSummary",
    "backtestMatrix",
    "chiFront",
    "chiBack",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should exist`);
  }
  assert.match(html, /1\/21,425,712/);
  assert.match(html, /前区 5 个 \+ 后区 2 个/);
});

test("DLT new advanced panels exist (prize, chase, independence, deep checkup)", () => {
  const html = read("dlt.html");
  // 新增 4 个 tab
  assert.match(html, /data-tab="prize"/);
  assert.match(html, /data-tab="chase"/);
  // 新增 panel id
  assert.match(html, /id="panel-prize"/);
  assert.match(html, /id="panel-chase"/);
  // 关键控件 id
  for (const id of [
    "prizeBand", "prizeTickets", "prizeKpiCompare", "prizeTable",
    "prizeAddEdge", "prizeBatchSummary",
    "chaseBankroll", "chaseDraws", "chaseTickets", "chaseStrategy", "chasePrizeBand",
    "chaseRuns", "btnChaseRun", "chaseSummary", "chaseChart", "chaseFinalDist", "chaseVerdict",
    "indCorr", "indOddChi", "indPairs",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should exist`);
  }
});

test("DLT prize panel exposes 9 award levels via JS module", async () => {
  const mod = await import("../assets/js/dlt-prize.js");
  assert.equal(mod.DLT_PRIZES.length, 9);
  // 一等奖必须是浮动
  assert.equal(mod.DLT_PRIZES[0].type, "floating");
  // 三等奖必须是固定 10000
  assert.equal(mod.DLT_PRIZES[2].fixedPrize, 10000);
});

test("DLT LSTM module loads and creates a model", async () => {
  const mod = await import("../assets/js/dlt-nn-model.js");
  const m = mod.createDltModel({ hiddenDim: 8, numLayers: 1 });
  assert.equal(m.hiddenDim, 8);
  assert.equal(m.numLayers, 1);
  assert.equal(m.frontHead.W.rows, 35);
  assert.equal(m.backHead.W.rows, 12);
});

test("PWA cache lists all new dlt-* modules", () => {
  const sw = read("sw.js");
  for (const mod of [
    "dlt-prize.js", "dlt-independence.js", "dlt-explainer.js", "dlt-chase.js",
    "dlt-nn-model.js", "dlt-nn-trainer.js", "dlt-nn-backtest.js", "dlt-lstm-controller.js",
  ]) {
    assert.match(sw, new RegExp(mod.replace(".", "\\."), ""), `${mod} missing in cache`);
  }
});
