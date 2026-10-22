// 端到端：4 项功能增强
//   1. 胆拖工具显示中奖率 + payback
//   2. 号码体检显示精确单注中奖率
//   3. 奖级 EV 显示盈亏平衡奖池
//   4. 冷热遗漏显示 χ² 异常号
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5188;
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

  // ===== 胆拖工具 =====
  console.log("[2] 胆拖工具：点计算");
  await page.evaluate(() => document.querySelector('[data-tab="tools"]').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector("#btnCalcDanTuo")?.click());
  await sleep(200);
  const dantuoText = await page.evaluate(() => document.querySelector("#danTuoResult")?.textContent || "");
  console.log("  dantuo result:", dantuoText.slice(0, 200));

  await page.evaluate(() => document.querySelector("#btnCalcComplex")?.click());
  await sleep(200);
  const complexText = await page.evaluate(() => document.querySelector("#complexResult")?.textContent || "");
  console.log("  complex result:", complexText.slice(0, 200));

  // ===== 号码体检 =====
  console.log("[3] 号码体检：分析一注");
  await page.evaluate(() => {
    const r = document.querySelector("#manualReds");
    if (r) r.value = "03 11 18 22 27 31";
    const b = document.querySelector("#manualBlue");
    if (b) b.value = "08";
  });
  await page.evaluate(() => document.querySelector("#btnAnalyseTicket")?.click());
  await sleep(200);
  const checkup = await page.evaluate(() => document.querySelector("#ticketAnalysis")?.textContent || "");

  // ===== 奖级 EV 显示盈亏平衡奖池 =====
  console.log("[4] 奖级 EV：盈亏平衡奖池");
  await page.evaluate(() => document.querySelector('[data-tab="prize"]').click());
  await sleep(400);
  const prizeText = await page.evaluate(() => document.querySelector("#ssqPrizeBatchSummary")?.textContent || "");

  // ===== 冷热遗漏 χ² =====
  console.log("[5] 冷热遗漏：χ² 异常号");
  await page.evaluate(() => document.querySelector('[data-tab="insight"]').click());
  await sleep(400);
  const insightChips = await page.evaluate(() => document.querySelector("#insightChips")?.textContent || "");

  const checks = [
    ["胆拖：显示中奖率", dantuoText.includes("中奖") || dantuoText.includes("中一")],
    ["胆拖：显示 payback", dantuoText.includes("payback") || dantuoText.includes("回报") || dantuoText.includes("期望")],
    ["复式：显示中奖率", complexText.includes("中奖") || complexText.includes("中一")],
    ["体检：显示精确中奖率", checkup.includes("中一注") || checkup.includes("精确") || checkup.includes("期望回报")],
    ["奖级：盈亏平衡奖池", prizeText.includes("盈亏平衡") || prizeText.includes("breakeven")],
    ["冷热：χ² chip 文案", insightChips.includes("χ²") || insightChips.includes("严格") || insightChips.includes("Bonferroni") || insightChips.includes("z=")],
  ];
  let pass = 0;
  for (const [n, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${n}`);
    if (ok) pass++;
  }
  console.log(`\n[6] console.error: ${errors.length}`);
  errors.slice(0, 3).forEach((e) => console.log(`    ! ${e}`));
  if (pass !== checks.length || errors.length) {
    console.log(`\n[FAIL] ${pass}/${checks.length}, errors=${errors.length}`);
    if (insightChips.length < 50) console.log("  insightChips text was:", JSON.stringify(insightChips));
    exitCode = 1;
  } else {
    console.log(`\n[PASS] ${pass}/${checks.length} · 0 错误 · 4 项增强全部生效`);
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
