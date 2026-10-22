// 端到端真浏览器测试：4 个新特性
//   1. Demo 模型加载
//   2. Predict 显示概率
//   3. 校准信息显示
//   4. UI 控件存在 (LCB λ / Ensemble K / Label smoothing)

import puppeteer from "puppeteer-core";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

for (const entry of ["index.html", "dlt.html"]) {
  const id = entry === "index.html" ? "ssq" : "dlt";
  console.log(`\n=== ${id.toUpperCase()} ===`);
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`  [${m.type()}]`, m.text());
  });
  page.on("pageerror", (e) => console.log(`  [pageerror]`, e.message));

  await page.goto(`http://localhost:5173/${entry}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1500));

  // 切到 LSTM tab
  await page.evaluate(() => document.querySelector('.tab[data-tab="lstm"]')?.click());
  await new Promise((r) => setTimeout(r, 500));

  // 检查控件
  const prefix = id === "ssq" ? "lstm" : "dltLstm";
  const inputs = await page.evaluate((p) => {
    const ids = ["LabelSmooth", "EnsembleK", "LcbLambda"];
    return ids.map(i => {
      const el = document.querySelector(`#${p}${i}`);
      return { id: `${p}${i}`, exists: !!el, value: el?.value };
    });
  }, prefix);
  for (const inp of inputs) {
    console.log(`  control ${inp.id}: ${inp.exists ? `✓ value=${inp.value}` : "✗ missing"}`);
  }

  // 点 demo 按钮
  const demoBtnId = id === "ssq" ? "btnLstmLoadDemo" : "btnDltLstmLoadDemo";
  console.log(`  clicking #${demoBtnId}`);
  const t0 = Date.now();
  try {
    await page.click(`#${demoBtnId}`);
  } catch (e) {
    console.log(`  ! click failed: ${e.message}`);
    continue;
  }
  // 等 demo 加载（fetch + apply）
  await new Promise((r) => setTimeout(r, 3000));

  const status = await page.evaluate((p) => {
    return document.querySelector(`#${p}Status`)?.textContent || "—";
  }, prefix);
  console.log(`  status after demo: "${status.slice(0, 80)}..."`);

  // 看 metrics 面板
  const metricsHasCalibration = await page.evaluate((p) => {
    const el = document.querySelector(`#${p}Metrics`);
    return el ? el.textContent.includes("温度") || el.textContent.includes("ECE") : false;
  }, prefix);
  console.log(`  metrics 含校准信息: ${metricsHasCalibration ? "✓" : "✗"}`);

  // 点 predict
  const predictId = id === "ssq" ? "btnLstmPredict" : "btnDltLstmPredict";
  const predictDisabled = await page.evaluate((id_) => {
    return document.querySelector(`#${id_}`)?.disabled;
  }, predictId);
  console.log(`  predict button disabled: ${predictDisabled}`);
  if (!predictDisabled) {
    await page.click(`#${predictId}`);
    await new Promise((r) => setTimeout(r, 800));
    const predictionShown = await page.evaluate((p) => {
      const card = document.querySelector(`#${p}PredictionCard`);
      return card && card.style.display !== "none";
    }, prefix);
    console.log(`  prediction card shown: ${predictionShown ? "✓" : "✗"}`);
  }

  console.log(`  total time: ${Date.now() - t0}ms`);
  await page.close();
}

await browser.close();
console.log("\n✓ All checks done.");
