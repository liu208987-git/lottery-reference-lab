// 复现：Service Worker 预缓存被重定向的 /dlt.html，导致第二次访问失败
import puppeteer from "puppeteer-core";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const HOST = process.argv[2] || "https://ssq-data-lab.pages.dev";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

// 用 *持久化* 用户数据，让 Service Worker 跨 page reload 存活
const page = await browser.newPage();

const log = (...a) => console.log(...a);
page.on("console", (m) => log(`[console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => log(`[pageerror]`, e.message));
page.on("requestfailed", (r) => log(`[reqfailed]`, r.url(), "-", r.failure()?.errorText));

log(`\n[1] 第一次访问首页（注册 Service Worker）`);
await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));

const swState1 = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  return {
    hasReg: !!reg,
    state: reg?.active?.state,
    scriptUrl: reg?.active?.scriptURL,
    controller: !!navigator.serviceWorker?.controller,
  };
});
log(`    SW state: ${JSON.stringify(swState1)}`);

log(`\n[2] 第一次点击 大乐透 链接`);
const t1 = Date.now();
try {
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`    最终 URL = ${page.url()} · ${Date.now() - t1}ms · ✅`);
} catch (e) {
  log(`    !! ${e.message}`);
}

log(`\n[3] 检查 SW 缓存内容`);
const cacheState = await page.evaluate(async () => {
  if (!navigator.serviceWorker?.controller) return { controlled: false };
  const keys = await caches.keys();
  const out = { controlled: true, caches: {} };
  for (const key of keys) {
    const cache = await caches.open(key);
    const reqs = await cache.keys();
    out.caches[key] = await Promise.all(reqs.slice(0, 50).map(async (r) => {
      const res = await cache.match(r);
      return {
        url: r.url,
        // 关键：如果 res.redirected==true，下次用就会 ERR_FAILED
        redirected: res?.redirected,
        type: res?.type,
        status: res?.status,
      };
    }));
  }
  return out;
});
log(`    controlled: ${cacheState.controlled}`);
if (cacheState.caches) {
  for (const [name, items] of Object.entries(cacheState.caches)) {
    const dlt = items.filter((i) => i.url.includes("dlt.html") || i.url.endsWith("/dlt"));
    log(`    cache ${name}: ${items.length} items`);
    if (dlt.length) {
      for (const d of dlt) {
        log(`      ⚠ ${d.url}  redirected=${d.redirected}  type=${d.type}  status=${d.status}`);
      }
    }
  }
}

log(`\n[4] 返回首页`);
await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));

log(`\n[5] 第二次点击 大乐透 链接（关键！这步用户报错）`);
const t2 = Date.now();
try {
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`    最终 URL = ${page.url()} · ${Date.now() - t2}ms · ✅ OK`);
} catch (e) {
  log(`    !! BUG REPRODUCED: ${e.message}`);
  log(`    最终 URL = ${page.url()}`);
}

await browser.close();
