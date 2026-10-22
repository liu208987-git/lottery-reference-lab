// 深度排查：v9 上 [4] 返回首页失败的真正原因
import puppeteer from "puppeteer-core";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const HOST = process.argv[2] || "https://ssq-data-lab.pages.dev";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();

const allRequests = [];
const allResponses = [];
const allFailed = [];
page.on("request", (r) => allRequests.push({ t: Date.now(), url: r.url(), method: r.method() }));
page.on("response", (r) => allResponses.push({ t: Date.now(), url: r.url(), status: r.status(), fromSW: r.fromServiceWorker() }));
page.on("requestfailed", (r) => allFailed.push({ t: Date.now(), url: r.url(), error: r.failure()?.errorText }));

const log = (...a) => console.log(...a);

log("\n[STEP 1] 首页（注册 SW）");
await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));
log(`  SW: ${JSON.stringify(await page.evaluate(async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  return { state: reg?.active?.state, controller: !!navigator.serviceWorker?.controller };
}))}`);

log("\n[STEP 2] 点击 大乐透");
allRequests.length = 0; allResponses.length = 0; allFailed.length = 0;
try {
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`  最终: ${page.url()}`);
} catch (e) {
  log(`  !! ${e.message}`);
}

log("\n[STEP 3] 看缓存（修复后应该是干净的）");
const cs = await page.evaluate(async () => {
  const keys = await caches.keys();
  const out = [];
  for (const key of keys) {
    const cache = await caches.open(key);
    const reqs = await cache.keys();
    for (const r of reqs) {
      if (r.url.endsWith("/dlt.html") || r.url.endsWith("/dlt") || r.url.endsWith("/index.html") || r.url.endsWith("/")) {
        const res = await cache.match(r);
        out.push({ cache: key, url: r.url, redirected: res?.redirected, type: res?.type, status: res?.status });
      }
    }
  }
  return out;
});
for (const e of cs) log(`  ${JSON.stringify(e)}`);

log("\n[STEP 4] 返回首页");
allRequests.length = 0; allResponses.length = 0; allFailed.length = 0;
try {
  await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });
  log(`  ✅ 成功`);
} catch (e) {
  log(`  !! ${e.message}`);
}
log(`  请求总数: ${allRequests.length}, 响应总数: ${allResponses.length}, 失败: ${allFailed.length}`);
for (const r of allRequests.slice(0, 10)) log(`    REQ ${r.method} ${r.url}`);
for (const r of allResponses.slice(0, 10)) log(`    RES ${r.status} ${r.url} (sw=${r.fromSW})`);
for (const r of allFailed) log(`    !! FAIL ${r.url} - ${r.error}`);

log("\n[STEP 5] 第二次点击大乐透");
allRequests.length = 0; allResponses.length = 0; allFailed.length = 0;
try {
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`  最终 URL = ${page.url()} ✅`);
} catch (e) {
  log(`  !! ${e.message}`);
  log(`  最终 URL = ${page.url()}`);
  for (const r of allFailed) log(`    !! FAIL ${r.url} - ${r.error}`);
}

await browser.close();
