// 端到端验证：SSQ 加载 demo 模型 → 预测 → 号码体检卡片显示 + 预测追踪写入 localStorage
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5181;
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
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (!/sw|service worker|favicon/i.test(t)) errors.push(t);
    }
  });
  page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

  console.log(`[1] open ${BASE}/index.html`);
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector("#btnLstmLoadDemo"), { timeout: 10000 });

  console.log(`[2] 切到 LSTM tab`);
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
      .find((el) => el.textContent.includes("LSTM"));
    if (tab) tab.click();
  });
  await sleep(300);

  console.log(`[3] 加载 demo 模型`);
  await page.evaluate(() => document.querySelector("#btnLstmLoadDemo")?.click());
  // 等待 predict 按钮启用
  await page.waitForFunction(() => !document.querySelector("#btnLstmPredict")?.disabled, { timeout: 15000 });

  console.log(`[4] 清空历史 + 点击预测`);
  await page.evaluate(() => localStorage.removeItem("lottery-prediction-history-v1"));
  await page.evaluate(() => document.querySelector("#btnLstmPredict")?.click());

  // 等待 explainer-card 出现
  console.log(`[5] 等待号码体检卡片`);
  await page.waitForFunction(() => !!document.querySelector(".explainer-card"), { timeout: 10000 });

  const info = await page.evaluate(() => {
    const card = document.querySelector(".explainer-card");
    const dims = Array.from(card?.querySelectorAll(".explainer-dim") || []);
    const score = card?.querySelector(".explainer-score strong")?.textContent;
    const lvl = card?.querySelector(".explainer-meta strong")?.textContent;
    return {
      hasCard: !!card,
      score: parseInt(score, 10),
      level: lvl,
      dimsCount: dims.length,
      dimsTitles: dims.map((d) => d.querySelector("strong")?.textContent),
    };
  });
  console.log(`     score=${info.score} · level=${info.level} · dims=${info.dimsCount}`);
  console.log(`     dims: ${info.dimsTitles?.join(" / ")}`);

  // 检查 localStorage 写入
  const histInfo = await page.evaluate(() => {
    const raw = localStorage.getItem("lottery-prediction-history-v1");
    if (!raw) return { count: 0 };
    const arr = JSON.parse(raw);
    return {
      count: arr.length,
      first: arr[0],
    };
  });
  console.log(`[6] localStorage history: ${histInfo.count} 条`);
  if (histInfo.first) {
    console.log(`     lottery=${histInfo.first.lottery} · targetIssue=${histInfo.first.targetIssue}`);
    console.log(`     topReds=${histInfo.first.topReds?.join(",")} · topBlue=${histInfo.first.topBlue?.join(",")}`);
  }

  const checks = [
    ["体检卡片可见", info.hasCard],
    ["总分 0-100 范围", info.score >= 0 && info.score <= 100],
    ["6 维度", info.dimsCount === 6],
    ["level 非空", !!info.level],
    ["history 写入 1 条", histInfo.count === 1],
    ["history 含 SSQ topReds", histInfo.first?.topReds?.length === 6],
    ["history 含 1 蓝", histInfo.first?.topBlue?.length === 1],
  ];
  let pass = 0;
  for (const [n, ok] of checks) {
    console.log(`     ${ok ? "✓" : "✗"} ${n}`);
    if (ok) pass++;
  }
  console.log(`\n[7] console.error: ${errors.length}`);
  errors.slice(0, 5).forEach((e) => console.log(`     ! ${e}`));

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
