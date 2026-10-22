// 端到端：SSQ 三个新 tab（回测/奖级 EV/追号风险）渲染 + 交互
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5187;
const server = spawn("node", ["tools/serve.mjs", String(PORT)], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
await sleep(800);

let exitCode = 0;
try {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/sw|service worker/i.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

  console.log("[1] open SSQ");
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });
  await sleep(1500);

  console.log("[2] 检查新 tab 都存在");
  const tabsExist = await page.evaluate(() => ({
    backtest: !!document.querySelector('[data-tab="backtest"]'),
    prize: !!document.querySelector('[data-tab="prize"]'),
    chase: !!document.querySelector('[data-tab="chase"]'),
  }));
  console.log("  ", JSON.stringify(tabsExist));

  // ============ 奖级 · EV ============
  console.log("[3] 切到「奖级 · EV」");
  await page.evaluate(() => document.querySelector('[data-tab="prize"]').click());
  await sleep(400);
  const prizeInfo = await page.evaluate(() => {
    const body = document.querySelector("#panel-prize");
    const text = body?.textContent || "";
    return {
      hasJackpotProb: text.includes("17,721,088") || text.includes("1,107,568"),
      hasPaybackRatio: text.includes("payback") || text.includes("Payback") || text.includes("元"),
      tableRows: document.querySelectorAll("#ssqPrizeTable tbody tr").length,
      hasEV: text.includes("EV") || text.includes("期望"),
      noTuijia: !text.includes("追加") || text.includes("没有"),  // 应该提到没有追加
    };
  });
  console.log("  ", JSON.stringify(prizeInfo));

  // 改 band 触发重渲染
  await page.select("#ssqPrizeBand", "aggressive");
  await sleep(200);
  const aggInfo = await page.evaluate(() => document.querySelector("#ssqPrizeKpi")?.textContent || "");
  console.log("  aggressive band 后 KPI 长度:", aggInfo.length);

  // ============ 追号风险 ============
  console.log("[4] 切到「追号风险」");
  await page.evaluate(() => document.querySelector('[data-tab="chase"]').click());
  await sleep(400);

  // 把 runs 调小加快测试
  await page.evaluate(() => {
    const r = document.querySelector("#ssqChaseRuns");
    if (r) r.value = "300";
    const d = document.querySelector("#ssqChaseDraws");
    if (d) d.value = "30";
  });
  await page.evaluate(() => document.querySelector("#btnSsqChaseRun")?.click());
  await sleep(2000);

  const chaseInfo = await page.evaluate(() => {
    const body = document.querySelector("#panel-chase");
    const text = body?.textContent || "";
    const summary = document.querySelector("#ssqChaseSummary")?.textContent || "";
    return {
      summaryHasResult: summary.includes("破产") || summary.includes("终值"),
      hasTrajectorySvg: !!document.querySelector("#ssqChaseChart svg"),
      hasHistogramSvg: !!document.querySelector("#ssqChaseFinalDist svg"),
      hasVerdict: text.includes("数学事实") || text.includes("赌徒谬误") || text.includes("结论"),
    };
  });
  console.log("  ", JSON.stringify(chaseInfo));

  // ============ 历史回测 ============
  console.log("[5] 切到「回测」");
  await page.evaluate(() => document.querySelector('[data-tab="backtest"]').click());
  await sleep(400);

  // 用最快的 legacy-uniform 跑小回测
  await page.evaluate(() => {
    const m = document.querySelector("#ssqBacktestMethod");
    if (m) m.value = "legacy-uniform";
    const r = document.querySelector("#ssqBacktestRounds");
    if (r) r.value = "20";
    const t = document.querySelector("#ssqBacktestTickets");
    if (t) t.value = "3";
  });
  await page.evaluate(() => document.querySelector("#btnSsqRunBacktest")?.click());
  await sleep(3000);

  const btInfo = await page.evaluate(() => {
    const summary = document.querySelector("#ssqBacktestSummary")?.textContent || "";
    return {
      summaryHasKpi: summary.includes("回测期数") || summary.includes("总注数"),
      matrixExists: !!document.querySelector("#ssqBacktestMatrix table"),
      bestExists: document.querySelector("#ssqBacktestBest")?.textContent.length > 50,
    };
  });
  console.log("  ", JSON.stringify(btInfo));

  const checks = [
    ["回测 tab 存在", tabsExist.backtest],
    ["奖级 EV tab 存在", tabsExist.prize],
    ["追号风险 tab 存在", tabsExist.chase],
    ["奖级表 6 行", prizeInfo.tableRows === 6],
    ["奖级显示概率", prizeInfo.hasJackpotProb],
    ["奖级 EV 文案", prizeInfo.hasEV],
    ["band 切换重渲染", aggInfo.length > 50],
    ["追号 summary 渲染", chaseInfo.summaryHasResult],
    ["追号轨迹 SVG", chaseInfo.hasTrajectorySvg],
    ["追号直方图 SVG", chaseInfo.hasHistogramSvg],
    ["追号 verdict", chaseInfo.hasVerdict],
    ["回测 KPI 渲染", btInfo.summaryHasKpi],
    ["命中矩阵渲染", btInfo.matrixExists],
    ["最好轮次渲染", btInfo.bestExists],
  ];
  let pass = 0;
  for (const [n, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${n}`);
    if (ok) pass++;
  }
  console.log(`\n[6] console.error: ${errors.length}`);
  errors.slice(0, 5).forEach((e) => console.log(`    ! ${e}`));

  if (pass !== checks.length || errors.length) {
    console.log(`\n[FAIL] ${pass}/${checks.length}, errors=${errors.length}`);
    exitCode = 1;
  } else {
    console.log(`\n[PASS] ${pass}/${checks.length} · 0 错误 · SSQ 已与 DLT 对等`);
  }

  await browser.close();
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  console.error(err.stack);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
