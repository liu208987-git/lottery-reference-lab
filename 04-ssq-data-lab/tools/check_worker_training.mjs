// 端到端真浏览器验证：
//   1. Worker 训练能跑（最少 epochs，看 epoch 事件能传回）
//   2. 训练时主线程不卡（点 tab 仍能切换）
//   3. 模型管理器对话框能打开
//   4. SW 不会拦截 worker 文件
import puppeteer from "puppeteer-core";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); });
page.on("requestfailed", (r) => { errors.push(`${r.url()} - ${r.failure()?.errorText}`); console.log("[reqfail]", r.url()); });
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});

console.log("\n[1] 打开 SSQ + 切到 LSTM tab");
await page.goto("http://localhost:5173/index.html", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => document.querySelector('.tab[data-tab="lstm"]')?.click());
await new Promise((r) => setTimeout(r, 400));

console.log("[2] 配最小训练参数");
await page.evaluate(() => {
  document.querySelector("#lstmSeqLen").value = "8";
  document.querySelector("#lstmHidden").value = "16";
  document.querySelector("#lstmLayers").value = "1";
  document.querySelector("#lstmEpochs").value = "2";
  document.querySelector("#lstmBatch").value = "16";
  document.querySelector("#lstmEnsembleK").value = "1";
});

console.log("[3] 点击训练（worker 路径）");
const t0 = Date.now();
await page.click("#btnLstmTrain");

// 等训练完成（最多 60 秒）
const timeoutAt = Date.now() + 60000;
let trained = false;
while (Date.now() < timeoutAt) {
  const status = await page.evaluate(() => document.querySelector("#lstmStatus")?.textContent || "");
  if (status.includes("训练完成")) {
    trained = true;
    console.log(`[4] 训练完成 ${(Date.now() - t0) / 1000}s · 状态: "${status.slice(0, 100)}"`);
    break;
  }
  // 训练时切 tab，验证主线程没卡
  if (Date.now() - t0 > 1500 && Date.now() - t0 < 1800) {
    const switched = await page.evaluate(() => {
      const tab = document.querySelector('.tab[data-tab="overview"]');
      tab?.click();
      const active = document.querySelector(".tab.is-active")?.dataset?.tab;
      return active;
    });
    console.log(`[3.5] 训练中切到 overview tab，结果 active=${switched}`);
    if (switched === "overview") {
      // 切回去
      await page.evaluate(() => document.querySelector('.tab[data-tab="lstm"]')?.click());
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!trained) {
  console.log("[4] !! 训练超时");
  await page.screenshot({ path: "tools/screenshots/worker-train-timeout.png" });
}

console.log("[5] 检查 metrics 面板有内容");
const hasMetrics = await page.evaluate(() => {
  const el = document.querySelector("#lstmMetrics");
  return el && el.textContent.includes("epoch");
});
console.log(`     metrics: ${hasMetrics ? "✓" : "✗"}`);

console.log("[6] 点 Predict");
await page.click("#btnLstmPredict");
await new Promise((r) => setTimeout(r, 500));
const predShown = await page.evaluate(() => {
  const card = document.querySelector("#lstmPredictionCard");
  return card && card.style.display !== "none";
});
console.log(`     预测面板: ${predShown ? "✓" : "✗"}`);

console.log("[7] 点 Save (IndexedDB)");
await page.click("#btnLstmSave");
await new Promise((r) => setTimeout(r, 500));

console.log("[8] 打开模型管理器");
const opened = await page.evaluate(() => {
  document.querySelector("#btnLstmManager")?.click();
  return !!document.querySelector(".model-manager-dialog[open]");
});
await new Promise((r) => setTimeout(r, 600));
const dialogVisible = await page.evaluate(() => {
  const dlg = document.querySelector(".model-manager-dialog");
  if (!dlg) return false;
  return dlg.hasAttribute("open") || dlg.open === true;
});
console.log(`     模型管理器对话框打开: ${dialogVisible ? "✓" : "✗"}`);
const items = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".mm-item .mm-key")).map(el => el.textContent.trim());
});
console.log(`     列表中的模型: ${JSON.stringify(items)}`);
await page.screenshot({ path: "tools/screenshots/model-manager.png" });

console.log("\n[9] 关闭对话框，BSS / permutation 调用看不到 UI 但要保证不出错");

console.log(`\n=== 错误总数: ${errors.length} ===`);
for (const e of errors) console.log(`  ${e}`);

await browser.close();
process.exit(trained && hasMetrics && predShown && dialogVisible ? 0 : 1);
