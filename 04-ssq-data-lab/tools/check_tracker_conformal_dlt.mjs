// DLT 版：tracker + conformal 端到端
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5183;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn("node", ["tools/serve.mjs", String(PORT)], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (b) => process.stdout.write(`[server] ${b}`));
server.stderr.on("data", (b) => process.stderr.write(`[server] ${b}`));
await sleep(800);

let exitCode = 0;
try {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      if (!/sw|service worker|favicon/i.test(t)) errors.push(t);
    }
  });
  page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

  console.log(`[1] open ${BASE}/dlt.html`);
  await page.goto(`${BASE}/dlt.html`, { waitUntil: "networkidle2", timeout: 20000 });

  console.log(`[2] 切到 LSTM tab + 清空 history`);
  await page.evaluate(() => localStorage.removeItem("lottery-prediction-history-v1"));
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
      .find((el) => el.textContent.includes("LSTM"));
    if (tab) tab.click();
  });
  await sleep(300);

  console.log(`[3] 验证 DLT tracker 空态`);
  await page.waitForFunction(() => !!document.querySelector("#dltLstmTrackerBody"), { timeout: 5000 });
  await sleep(200);  // 等 mount setTimeout 触发
  const empty = await page.evaluate(() => {
    const b = document.querySelector("#dltLstmTrackerBody");
    const text = b?.textContent || "";
    return {
      ok: text.includes("还没有预测记录"),
      preview: text.slice(0, 30),
      childCount: b?.children?.length,
    };
  });
  console.log(`     空态文案: ${JSON.stringify(empty)}`);

  console.log(`[4] 加载 DLT demo 模型`);
  await page.evaluate(() => document.querySelector("#btnDltLstmLoadDemo")?.click());
  await page.waitForFunction(() => !document.querySelector("#btnDltLstmPredict")?.disabled, { timeout: 15000 });

  console.log(`[5] 预测`);
  await page.evaluate(() => document.querySelector("#btnDltLstmPredict")?.click());
  await sleep(500);

  console.log(`[6] 验证 tracker 有等待开奖`);
  await page.waitForFunction(() => {
    const b = document.querySelector("#dltLstmTrackerBody");
    return b && (b.textContent.includes("等待开奖") || b.textContent.includes("已结算"));
  }, { timeout: 5000 });
  const trk = await page.evaluate(() => {
    const b = document.querySelector("#dltLstmTrackerBody");
    return {
      hasWaiting: b?.textContent.includes("等待开奖"),
      hasRefresh: !!b?.querySelector("[data-tracker-act='refresh']"),
    };
  });
  console.log(`     ${JSON.stringify(trk)}`);

  console.log(`[7] 回测`);
  await page.evaluate(() => document.querySelector("#btnDltLstmBacktest")?.click());
  await page.waitForFunction(() => {
    const c = document.querySelector("#dltLstmConformalCard");
    return c && c.style.display !== "none";
  }, { timeout: 90000 });

  console.log(`[8] 验证共形面板 + 球可视化`);
  const cInfo = await page.evaluate(() => {
    const body = document.querySelector("#dltLstmConformalBody");
    const text = body?.textContent || "";
    return {
      hasBody: !!body,
      hasSlider: !!body?.querySelector("#conformalAlpha"),
      hasQHat: text.includes("共形阈值") || text.includes("q̂") || text.includes("q\u0302"),
      hasCoverage: text.includes("经验覆盖率"),
      hasAvgSize: text.includes("平均集合大小"),
      hasFrontBalls: !!body?.querySelector(".ball.front"),
      bodyLength: body?.innerHTML?.length || 0,
    };
  });
  console.log(`     ${JSON.stringify(cInfo)}`);

  console.log(`[9] 滑 α 0.1 → 0.05`);
  await page.evaluate(() => {
    const s = document.querySelector("#conformalAlpha");
    if (!s) return;
    s.value = "0.05";
    s.dispatchEvent(new Event("input"));
    s.dispatchEvent(new Event("change"));
  });
  await sleep(200);
  const after = await page.evaluate(() => {
    const txt = document.querySelector("#conformalAlphaVal")?.textContent;
    return { display: txt };
  });
  console.log(`     α display=${after.display}`);

  const checks = [
    ["DLT empty 文案", empty],
    ["预测后等待开奖", trk.hasWaiting],
    ["tracker 刷新按钮", trk.hasRefresh],
    ["共形 body 渲染", cInfo.hasBody && cInfo.bodyLength > 500],
    ["α 滑块", cInfo.hasSlider],
    ["q̂ 显示", cInfo.hasQHat],
    ["经验覆盖率", cInfo.hasCoverage],
    ["平均集合大小", cInfo.hasAvgSize],
    ["前区球可视化", cInfo.hasFrontBalls],
    ["α 滑动响应", after.display === "0.05"],
  ];
  let pass = 0;
  for (const [n, ok] of checks) {
    console.log(`     ${ok ? "✓" : "✗"} ${n}`);
    if (ok) pass++;
  }
  console.log(`\n[10] console.error: ${errors.length}`);
  errors.slice(0, 5).forEach((e) => console.log(`      ! ${e}`));
  if (pass !== checks.length || errors.length) {
    console.log(`\n[FAIL] DLT ${pass}/${checks.length}, errors=${errors.length}`);
    exitCode = 1;
  } else {
    console.log(`\n[PASS] DLT ${pass}/${checks.length} · 0 错误`);
  }

  await browser.close();
} catch (err) {
  console.error(`\n[ERROR] ${err.message}`);
  console.error(err.stack);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
