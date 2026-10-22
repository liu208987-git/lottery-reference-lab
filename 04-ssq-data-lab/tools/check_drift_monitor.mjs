// 端到端：SSQ + DLT 漂移监测面板渲染
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5184;
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
    { url: "/index.html", driftId: "#lstmDriftBody", name: "SSQ" },
    { url: "/dlt.html", driftId: "#dltLstmDriftBody", name: "DLT" },
  ]) {
    console.log(`\n=== ${cfg.name} (${cfg.url}) ===`);
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/sw|service worker/i.test(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

    await page.goto(`http://127.0.0.1:${PORT}${cfg.url}`, { waitUntil: "networkidle2", timeout: 20000 });
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
        .find((el) => el.textContent.includes("LSTM"));
      if (tab) tab.click();
    });
    await sleep(800);

    await page.waitForFunction((sel) => {
      const b = document.querySelector(sel);
      return b && b.children.length > 0;
    }, { timeout: 10000 }, cfg.driftId);

    const info = await page.evaluate((sel) => {
      const b = document.querySelector(sel);
      const text = b?.textContent || "";
      return {
        hasBody: !!b,
        bodyLength: b?.innerHTML?.length || 0,
        hasPSI: text.includes("PSI"),
        hasVerdict: text.includes("稳定") || text.includes("漂移"),
        hasRolling: text.includes("滚动 PSI") || text.includes("滚动"),
        hasContrib: text.includes("贡献度") || text.includes("Top-5") || text.includes("贡献度 Top-5"),
        svgCount: b?.querySelectorAll("svg")?.length ?? 0,
      };
    }, cfg.driftId);

    console.log(JSON.stringify(info, null, 2));

    const checks = [
      ["body 渲染", info.hasBody && info.bodyLength > 800],
      ["PSI 文案", info.hasPSI],
      ["verdict 显示", info.hasVerdict],
      ["滚动 PSI 卡", info.hasRolling],
      ["贡献度 Top-5", info.hasContrib],
      ["SVG 滚动图", info.svgCount >= 1],
    ];
    let pass = 0;
    for (const [n, ok] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${n}`);
      if (ok) pass++;
    }
    console.log(`  errors: ${errors.length}`);
    errors.slice(0, 3).forEach((e) => console.log(`    ! ${e}`));
    if (pass !== checks.length || errors.length) {
      console.log(`  [FAIL] ${pass}/${checks.length}`);
      exitCode = 1;
    } else {
      console.log(`  [PASS] ${pass}/${checks.length}`);
    }
    await page.close();
  }

  await browser.close();
  if (exitCode === 0) console.log("\n[PASS] drift monitor 双端正常");
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  console.error(err.stack);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
