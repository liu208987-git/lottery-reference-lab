// 端到端：SSQ 加载 demo 模型 → 预测（写 1 条 history） → 切到 LSTM tab
//   验证 #lstmTrackerCard 显示 1 条等待开奖
//   点回测 → 验证 #lstmConformalCard 显示，含 α 滑块和 q̂ / 经验覆盖率
//   滑动 α 验证刷新

import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5182;
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

  console.log(`[1] open ${BASE}/index.html`);
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });

  console.log(`[2] 切到 LSTM tab + 清空历史`);
  await page.evaluate(() => localStorage.removeItem("lottery-prediction-history-v1"));
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
      .find((el) => el.textContent.includes("LSTM"));
    if (tab) tab.click();
  });
  await sleep(300);

  console.log(`[3] 验证 tracker 空态`);
  await page.waitForFunction(() => !!document.querySelector("#lstmTrackerBody"), { timeout: 5000 });
  await sleep(200);  // 等 mountTracker setTimeout 触发
  const empty = await page.evaluate(() => {
    const b = document.querySelector("#lstmTrackerBody");
    return b?.textContent.includes("还没有预测记录");
  });
  console.log(`     空态文案: ${empty}`);

  console.log(`[4] 加载 demo 模型`);
  await page.evaluate(() => document.querySelector("#btnLstmLoadDemo")?.click());
  await page.waitForFunction(() => !document.querySelector("#btnLstmPredict")?.disabled, { timeout: 15000 });

  console.log(`[5] 点击预测`);
  await page.evaluate(() => document.querySelector("#btnLstmPredict")?.click());
  await sleep(500);

  console.log(`[6] 验证 tracker 显示等待开奖`);
  // 等 tracker 更新
  await page.waitForFunction(() => {
    const b = document.querySelector("#lstmTrackerBody");
    return b && (b.textContent.includes("条预测等待开奖") || b.textContent.includes("已结算"));
  }, { timeout: 5000 });
  const trackerInfo = await page.evaluate(() => {
    const b = document.querySelector("#lstmTrackerBody");
    return {
      hasWaiting: b?.textContent.includes("等待开奖"),
      hasRefresh: !!b?.querySelector("[data-tracker-act='refresh']"),
    };
  });
  console.log(`     hasWaiting=${trackerInfo.hasWaiting} · hasRefresh=${trackerInfo.hasRefresh}`);

  console.log(`[7] 点回测（生成共形面板需要 records）`);
  await page.evaluate(() => document.querySelector("#btnLstmBacktest")?.click());
  await page.waitForFunction(() => {
    const c = document.querySelector("#lstmConformalCard");
    return c && c.style.display !== "none";
  }, { timeout: 60000 });

  console.log(`[8] 验证共形面板`);
  const cInfo = await page.evaluate(() => {
    const body = document.querySelector("#lstmConformalBody");
    const slider = body?.querySelector("#conformalAlpha");
    const text = body?.textContent || "";
    return {
      hasBody: !!body,
      hasSlider: !!slider,
      sliderValue: slider?.value,
      hasQHat: text.includes("共形阈值") || text.includes("q̂") || text.includes("q\u0302"),
      hasCoverage: text.includes("经验覆盖率"),
      hasExpected: text.includes("期望覆盖率"),
      hasAvgSize: text.includes("平均集合大小"),
      bodyLength: body?.innerHTML?.length || 0,
    };
  });
  console.log(`     ${JSON.stringify(cInfo)}`);

  console.log(`[9] 滑 α 0.1 → 0.3`);
  await page.evaluate(() => {
    const s = document.querySelector("#conformalAlpha");
    if (!s) return;
    s.value = "0.3";
    s.dispatchEvent(new Event("input"));
    s.dispatchEvent(new Event("change"));
  });
  await sleep(200);
  const after = await page.evaluate(() => {
    const txt = document.querySelector("#conformalAlphaVal")?.textContent;
    const slider = document.querySelector("#conformalAlpha")?.value;
    const expected = (1 - parseFloat(slider)) * 100;
    const body = document.querySelector("#lstmConformalBody")?.textContent || "";
    return { display: txt, slider, expectedShown: body.includes(`${expected.toFixed(1)}%`) };
  });
  console.log(`     α display=${after.display}, slider=${after.slider}, expected shown=${after.expectedShown}`);

  const checks = [
    ["empty 文案显示", empty],
    ["预测后 tracker 等待开奖", trackerInfo.hasWaiting],
    ["tracker 有刷新按钮", trackerInfo.hasRefresh],
    ["共形面板 body 渲染", cInfo.hasBody && cInfo.bodyLength > 500],
    ["α 滑块存在", cInfo.hasSlider],
    ["q̂ 显示", cInfo.hasQHat],
    ["经验覆盖率显示", cInfo.hasCoverage],
    ["平均集合大小显示", cInfo.hasAvgSize],
    ["α 滑动响应", after.display === "0.30"],
  ];
  let pass = 0;
  for (const [n, ok] of checks) {
    console.log(`     ${ok ? "✓" : "✗"} ${n}`);
    if (ok) pass++;
  }
  console.log(`\n[10] console.error: ${errors.length}`);
  errors.slice(0, 5).forEach((e) => console.log(`      ! ${e}`));

  if (pass !== checks.length || errors.length) {
    console.log(`\n[FAIL] ${pass}/${checks.length}, errors=${errors.length}`);
    exitCode = 1;
  } else {
    console.log(`\n[PASS] ${pass}/${checks.length} · 0 错误`);
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
