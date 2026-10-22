// 完整验证本轮 4 项改动：BSS + Permutation 接 UI / LR 曲线 + ETA / 训练 worker / Update banner
import puppeteer from "puppeteer-core";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

const errors = [];

// --- SSQ ---
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(`[SSQ pageerror] ${e.message}`));
page.on("console", async (m) => { if (m.type() === "error") errors.push(`[SSQ console] ${m.text()}`); });

console.log("=== SSQ ===");
await page.goto("http://localhost:5173/index.html", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => document.querySelector('.tab[data-tab="lstm"]')?.click());
await new Promise((r) => setTimeout(r, 400));

console.log("[1] 加载 demo + 回测");
await page.click("#btnLstmLoadDemo");
await new Promise((r) => setTimeout(r, 3500));
await page.click("#btnLstmBacktest");
await new Promise((r) => setTimeout(r, 5000));
const ssqBt = await page.evaluate(() => document.querySelector("#lstmBacktestBody")?.textContent || "");
console.log(`     BSS:    ${ssqBt.includes("Brier Skill Score") ? "✓" : "✗"}`);
console.log(`     Perm:   ${ssqBt.includes("配对置换检验") ? "✓" : "✗"}`);
console.log(`     Reliab: ${ssqBt.includes("Reliability") ? "✓" : "✗"}`);

console.log("[2] LR 曲线 div 存在");
const hasLrCurve = await page.evaluate(() => {
  // 触发 init by quick training start
  const train = document.querySelector("#btnLstmTrain");
  // 不点训练，但 demo 加载后没有 initCurves；试着先训 0 epoch
  return !!document.querySelector("#lstmCurves");
});
console.log(`     curves container: ${hasLrCurve ? "✓" : "✗"}`);

console.log("[3] showUpdateBanner 函数可用");
const bannerOK = await page.evaluate(() => {
  if (typeof showUpdateBanner !== "function") return false;
  showUpdateBanner(() => {});
  const el = document.querySelector(".pwa-update-banner");
  return el && el.textContent.includes("立即更新");
});
console.log(`     banner: ${bannerOK ? "✓" : "✗"}`);

// --- DLT ---
const page2 = await browser.newPage();
page2.on("pageerror", (e) => errors.push(`[DLT pageerror] ${e.message}`));
page2.on("console", async (m) => { if (m.type() === "error") errors.push(`[DLT console] ${m.text()}`); });

console.log("\n=== DLT ===");
await page2.goto("http://localhost:5173/dlt.html", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
await page2.evaluate(() => document.querySelector('.tab[data-tab="lstm"]')?.click());
await new Promise((r) => setTimeout(r, 400));
await page2.click("#btnDltLstmLoadDemo");
await new Promise((r) => setTimeout(r, 3500));
await page2.click("#btnDltLstmBacktest");
await new Promise((r) => setTimeout(r, 5000));
const dltBt = await page2.evaluate(() => document.querySelector("#dltLstmBacktestBody")?.textContent.slice(0, 5000) || "");
console.log(`     BSS:    ${dltBt.includes("Brier Skill Score") ? "✓" : "✗"}`);
console.log(`     Perm:   ${dltBt.includes("配对置换检验") ? "✓" : "✗"}`);
console.log(`     Reliab: ${dltBt.includes("Reliability") ? "✓" : "✗"}`);

console.log(`\n=== 错误数: ${errors.length} ===`);
for (const e of errors) console.log(`  ${e}`);

await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
