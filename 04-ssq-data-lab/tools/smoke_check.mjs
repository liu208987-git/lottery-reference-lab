// 简单冒烟测试：打开 SSQ + DLT 主页，check 0 console.error
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

  for (const path of ["/index.html", "/dlt.html"]) {
    console.log(`\n[${path}]`);
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") {
        const t = m.text();
        if (!/sw|service worker|favicon/i.test(t)) errors.push(t);
      }
    });
    page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle2", timeout: 20000 });
    await sleep(1500);

    // 切 LSTM tab
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
        .find((el) => el.textContent.includes("LSTM"));
      if (tab) tab.click();
    });
    await sleep(800);  // 等 mountTracker setTimeout 异步触发

    const trackerOk = await page.evaluate(() => {
      const ssq = document.querySelector("#lstmTrackerBody");
      const dlt = document.querySelector("#dltLstmTrackerBody");
      const target = ssq || dlt;
      return !!target && target.children.length > 0;
    });

    console.log(`  console.errors: ${errors.length}`);
    console.log(`  tracker mounted: ${trackerOk}`);
    errors.forEach((e) => console.log(`  ! ${e}`));
    if (errors.length > 0 || !trackerOk) exitCode = 1;
    await page.close();
  }

  await browser.close();
  if (exitCode === 0) console.log("\n[PASS] smoke OK");
  else console.log("\n[FAIL] errors found");
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
