// 复现"在 SSQ 首页点击 大乐透 按钮"的完整真浏览器流程，
// 看每一跳的 URL、status、是否进入 ERR 状态。
import puppeteer from "puppeteer-core";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const HOST = process.argv[2] || "https://ssq-data-lab.pages.dev";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-cache",
    "--disable-application-cache",
    "--disable-offline-load-stale-cache",
    "--disable-gpu-shader-disk-cache",
    "--media-cache-size=0",
    "--disk-cache-size=0",
  ],
});

const page = await browser.newPage();

// 完全禁用缓存，模拟"清缓存的新用户"
await page.setCacheEnabled(false);
const client = await page.target().createCDPSession();
await client.send("Network.clearBrowserCache");
await client.send("Network.clearBrowserCookies");

// 抓所有 redirect chain
const redirects = [];
page.on("response", (res) => {
  redirects.push({
    url: res.url(),
    status: res.status(),
    location: res.headers()["location"],
    server: res.headers()["server"],
    cfRay: res.headers()["cf-ray"],
  });
});
page.on("requestfailed", (req) => {
  redirects.push({
    url: req.url(),
    status: "FAILED",
    error: req.failure()?.errorText,
  });
});

console.log(`\n[1] 打开 ${HOST}/index.html`);
const t0 = Date.now();
try {
  const r = await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2", timeout: 30000 });
  console.log(`    -> HTTP ${r?.status()}, ${Date.now() - t0}ms`);
} catch (e) {
  console.log(`    -> FAILED: ${e.message}`);
  await browser.close();
  process.exit(1);
}

console.log(`\n[2] 找到 大乐透 链接`);
const dltLink = await page.evaluate(() => {
  const a = document.querySelector('.lottery-switcher a[href*="dlt"]');
  return a ? { href: a.href, text: a.textContent.trim() } : null;
});
console.log(`    href = ${dltLink?.href}`);
console.log(`    text = ${dltLink?.text}`);

console.log(`\n[3] 模拟点击（等同于直接 navigate 到 href）`);
redirects.length = 0;
const t1 = Date.now();
try {
  // 用真实点击
  const navPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navPromise;
  console.log(`    最终 URL = ${page.url()}`);
  console.log(`    耗时 ${Date.now() - t1}ms`);
} catch (e) {
  console.log(`    !! NAV FAILED: ${e.message}`);
  console.log(`    最终 URL = ${page.url()}`);
}

console.log(`\n[4] 完整请求链：`);
for (const r of redirects) {
  if (r.status === "FAILED") {
    console.log(`    X ${r.url} -> ${r.error}`);
  } else {
    const loc = r.location ? ` -> ${r.location}` : "";
    console.log(`    ${r.status} ${r.url}${loc}`);
  }
}

console.log(`\n[5] 页面状态：`);
const state = await page.evaluate(() => ({
  title: document.title,
  bodyDataset: document.body?.dataset?.lottery,
  drawCount: document.querySelector("#mCount")?.textContent,
  hasDltContent: !!document.querySelector('[data-tab="prize"]'),
}));
console.log(`    title = ${state.title}`);
console.log(`    body data-lottery = ${state.bodyDataset}`);
console.log(`    drawCount = ${state.drawCount}`);
console.log(`    hasDltContent = ${state.hasDltContent}`);

await browser.close();
