// 用本地 Chrome 跑 dlt.html，抓 console + page error + 网络失败。
import puppeteer from "puppeteer-core";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const TARGET = process.argv[2] || "http://localhost:5173/dlt.html";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
const consoleMsgs = [];
const pageErrors = [];
const failedReqs = [];

page.on("console", (msg) => {
  consoleMsgs.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => {
  pageErrors.push({ message: err.message, stack: err.stack });
});
page.on("requestfailed", (req) => {
  failedReqs.push({ url: req.url(), error: req.failure()?.errorText });
});
page.on("response", async (res) => {
  if (res.status() >= 400) {
    failedReqs.push({ url: res.url(), status: res.status() });
  }
});

const t0 = Date.now();
try {
  const resp = await page.goto(TARGET, { waitUntil: "networkidle2", timeout: 30000 });
  console.log(`[load] ${TARGET} -> HTTP ${resp?.status()} in ${Date.now() - t0}ms`);
} catch (e) {
  console.log(`[load] FAILED: ${e.message}`);
}

// 等待 DOMContentLoaded handler 跑完
await new Promise((r) => setTimeout(r, 1500));

// 抓页面状态
const pageState = await page.evaluate(() => {
  return {
    title: document.title,
    bodyDataset: document.body?.dataset?.lottery,
    activeTab: document.querySelector(".tab.is-active")?.dataset?.tab,
    drawCount: document.querySelector("#mCount")?.textContent,
    range: document.querySelector("#mRange")?.textContent,
    latestIssue: document.querySelector("#latestIssue")?.textContent,
    hasLstmTab: !!document.querySelector('[data-tab="lstm"]'),
    hasPrizeTab: !!document.querySelector('[data-tab="prize"]'),
    hasChaseTab: !!document.querySelector('[data-tab="chase"]'),
    hasLatestBalls: document.querySelector("#latestBalls")?.children.length,
    chartFrontAllSvgs: document.querySelector("#chartFrontAll")?.querySelectorAll("svg").length,
    consoleErrorCount: 0,
  };
});

console.log("\n=== Page state ===");
console.log(JSON.stringify(pageState, null, 2));

console.log("\n=== Console messages ===");
for (const m of consoleMsgs) {
  console.log(`[${m.type}] ${m.text}`);
}
console.log(`(total: ${consoleMsgs.length})`);

console.log("\n=== Page errors ===");
for (const e of pageErrors) {
  console.log(`!! ${e.message}`);
  if (e.stack) console.log(e.stack.split("\n").slice(0, 5).join("\n"));
}
console.log(`(total: ${pageErrors.length})`);

console.log("\n=== Failed network ===");
for (const f of failedReqs) {
  console.log(`X ${f.url} - ${f.error || "HTTP " + f.status}`);
}
console.log(`(total: ${failedReqs.length})`);

await browser.close();
process.exit(pageErrors.length > 0 ? 1 : 0);
