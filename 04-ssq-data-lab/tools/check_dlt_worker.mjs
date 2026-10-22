import puppeteer from "puppeteer-core";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); });
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

await page.goto("http://localhost:5173/dlt.html", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => document.querySelector('.tab[data-tab="lstm"]')?.click());
await new Promise((r) => setTimeout(r, 400));

await page.evaluate(() => {
  document.querySelector("#dltLstmSeqLen").value = "8";
  document.querySelector("#dltLstmHidden").value = "16";
  document.querySelector("#dltLstmLayers").value = "1";
  document.querySelector("#dltLstmEpochs").value = "2";
  document.querySelector("#dltLstmBatch").value = "16";
  document.querySelector("#dltLstmEnsembleK").value = "1";
});

console.log("DLT 训练（worker）...");
const t0 = Date.now();
await page.click("#btnDltLstmTrain");

const timeoutAt = Date.now() + 60000;
let trained = false;
while (Date.now() < timeoutAt) {
  const status = await page.evaluate(() => document.querySelector("#dltLstmStatus")?.textContent || "");
  if (status.includes("训练完成")) {
    trained = true;
    console.log(`训练完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

const ok = await page.evaluate(() => {
  document.querySelector("#btnDltLstmPredict")?.click();
  return true;
});
await new Promise((r) => setTimeout(r, 500));
const predShown = await page.evaluate(() => {
  const card = document.querySelector("#dltLstmPredictionCard");
  return card && card.style.display !== "none";
});
console.log(`预测面板: ${predShown ? "✓" : "✗"}`);

console.log("打开模型管理器");
await page.click("#btnDltLstmManager");
await new Promise((r) => setTimeout(r, 500));
const dialogVisible = await page.evaluate(() => !!document.querySelector(".model-manager-dialog"));
console.log(`对话框: ${dialogVisible ? "✓" : "✗"}`);

console.log(`错误数: ${errors.length}`);
await browser.close();
process.exit(trained && predShown && dialogVisible && errors.length === 0 ? 0 : 1);
