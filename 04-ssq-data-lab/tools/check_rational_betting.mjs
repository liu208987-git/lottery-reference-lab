// 端到端：SSQ + DLT 理性投注工作台
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5185;
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

  for (const cfg of [
    { url: "/index.html", name: "SSQ" },
    { url: "/dlt.html", name: "DLT" },
  ]) {
    console.log(`\n=== ${cfg.name} ===`);
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/sw|service worker/i.test(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

    await page.goto(`http://127.0.0.1:${PORT}${cfg.url}`, { waitUntil: "networkidle2", timeout: 20000 });
    await sleep(800);

    // 切到理性投注 tab
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll(".tab")).find((t) => t.dataset.tab === "rational");
      if (tab) tab.click();
    });
    await sleep(500);

    const info = await page.evaluate(() => {
      const body = document.querySelector("#rationalBettingBody");
      const text = body?.textContent || "";
      return {
        hasBody: !!body,
        bodyLength: body?.innerHTML?.length || 0,
        hasJackpotProb: text.includes("17,721,088") || text.includes("21,425,712"),
        hasEV: text.includes("EV") || text.includes("期望"),
        hasKelly: text.includes("Kelly"),
        hasCoverage: text.includes("覆盖率") || text.includes("互不重复"),
        hasBankrupt: text.includes("破产"),
        hasInputs: document.querySelectorAll("#rationalBettingBody input[type=number]").length,
        hasButtons: document.querySelectorAll("#rationalBettingBody button").length,
      };
    });
    console.log(JSON.stringify(info, null, 2));

    // 改 jackpot 触发重渲染
    await page.evaluate(() => {
      const j = document.querySelector("#rbJackpot");
      if (j) {
        j.value = "100000000";
        j.dispatchEvent(new Event("change"));
      }
    });
    await sleep(300);
    const evAfter = await page.evaluate(() => {
      const text = document.querySelector("#rationalBettingBody")?.textContent || "";
      // 极端奖池下 EV 应 > 2，shouldPlay
      return {
        hasShouldPlay: text.includes("值得投") || text.includes("EV > "),
      };
    });
    console.log(`  high jackpot: ${JSON.stringify(evAfter)}`);

    // 跑覆盖率
    await page.evaluate(() => document.querySelector("#rbRunCoverage")?.click());
    await sleep(2500);
    const cov = await page.evaluate(() => {
      const r = document.querySelector("#rbCoverageResult")?.textContent || "";
      return {
        hasResult: r.includes("互不重复"),
        hasCI: r.includes("95% CI") || r.includes("CI ["),
      };
    });
    console.log(`  coverage: ${JSON.stringify(cov)}`);

    // 跑模拟
    await page.evaluate(() => document.querySelector("#rbRunSim")?.click());
    await sleep(1500);
    const sim = await page.evaluate(() => {
      const r = document.querySelector("#rbSimResult")?.textContent || "";
      const svg = document.querySelector("#rbSimResult svg");
      return {
        hasResult: r.includes("最终本金") || r.includes("破产概率"),
        hasSvg: !!svg,
      };
    });
    console.log(`  sim: ${JSON.stringify(sim)}`);

    const checks = [
      ["body 渲染", info.hasBody && info.bodyLength > 2000],
      ["显示一等奖概率", info.hasJackpotProb],
      ["EV 文案", info.hasEV],
      ["Kelly 文案", info.hasKelly],
      ["覆盖率文案", info.hasCoverage],
      ["破产文案", info.hasBankrupt],
      ["≥3 输入框", info.hasInputs >= 3],
      ["≥2 按钮", info.hasButtons >= 2],
      ["极端奖池触发 should play", evAfter.hasShouldPlay],
      ["覆盖率结果渲染", cov.hasResult],
      ["模拟结果渲染", sim.hasResult],
      ["模拟 SVG 轨迹", sim.hasSvg],
    ];
    let pass = 0;
    for (const [n, ok] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${n}`);
      if (ok) pass++;
    }
    console.log(`  errors: ${errors.length}`);
    errors.slice(0, 3).forEach((e) => console.log(`    ! ${e}`));

    if (pass !== checks.length || errors.length) {
      console.log(`  [FAIL] ${pass}/${checks.length}, errors=${errors.length}`);
      exitCode = 1;
    } else {
      console.log(`  [PASS] ${pass}/${checks.length}`);
    }
    await page.close();
  }

  await browser.close();
  if (exitCode === 0) console.log("\n[PASS] 双端理性投注台正常");
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  console.error(err.stack);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
