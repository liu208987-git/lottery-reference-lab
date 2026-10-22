// 模拟 Cloudflare Pages 的 308 行为：把 /dlt.html 重定向到 /dlt
// 然后验证 sw.js v9 在这种情况下"二次访问 dlt.html"不再卡住
import puppeteer from "puppeteer-core";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
const log = (...a) => console.log(...a);
page.on("pageerror", (e) => log("[pageerror]", e.message));
page.on("requestfailed", (r) => log("[reqfailed]", r.url(), "-", r.failure()?.errorText));

// 关键：在浏览器请求层注入 308，模拟生产环境
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  // 只把 navigation/document 类型的 dlt.html 308 重定向到 /dlt
  // 不要拦截 SW 内部的预缓存请求（有 sec-fetch-dest 区分）
  if (
    url.endsWith("/dlt.html") &&
    req.resourceType() === "document"
  ) {
    log(`  [intercept] 308 ${url} → /dlt`);
    req.respond({
      status: 308,
      headers: { Location: "/dlt" },
      body: "",
    });
    return;
  }
  // /dlt 路径在本地其实没有，重定向回 /dlt.html 让本地 server 处理
  // ——但这样会无限循环。改成：从本地直接读 dlt.html 内容代理到 /dlt
  if (url.endsWith("/dlt") && req.resourceType() === "document") {
    log(`  [intercept] /dlt → continue as /dlt.html (no redirect tag)`);
    // 用 fetch 拿真实 dlt.html 内容
    fetch("http://localhost:5173/dlt.html")
      .then(async (r) => {
        const body = await r.text();
        req.respond({
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body,
        });
      })
      .catch((e) => req.abort());
    return;
  }
  req.continue();
});

const HOST = "http://localhost:5173";

log("\n[1] 第一次打开首页（同时模拟生产 308）");
await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2500));

const sw1 = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  return {
    hasReg: !!reg,
    state: reg?.active?.state,
    controller: !!navigator.serviceWorker?.controller,
  };
});
log(`    SW: ${JSON.stringify(sw1)}`);

log("\n[2] 第一次点击 大乐透");
const t1 = Date.now();
try {
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`    最终 URL = ${page.url()} · ${Date.now() - t1}ms · ✅`);
} catch (e) {
  log(`    !! ${e.message}`);
}

log("\n[3] 检查 SW 缓存：dlt.html 不应该有 redirected=true");
const cacheState = await page.evaluate(async () => {
  if (!navigator.serviceWorker?.controller) return { controlled: false };
  const keys = await caches.keys();
  const out = { controlled: true, caches: {} };
  for (const key of keys) {
    const cache = await caches.open(key);
    const reqs = await cache.keys();
    const dlt = [];
    for (const r of reqs) {
      if (r.url.endsWith("/dlt.html") || r.url.endsWith("/dlt")) {
        const res = await cache.match(r);
        dlt.push({ url: r.url, redirected: res?.redirected, status: res?.status, type: res?.type });
      }
    }
    out.caches[key] = { total: reqs.length, dltEntries: dlt };
  }
  return out;
});
log(`    ${JSON.stringify(cacheState, null, 2).split("\n").map((l) => "    " + l).join("\n")}`);
const polluted = Object.values(cacheState.caches || {}).some((c) =>
  c.dltEntries?.some((d) => d.redirected === true)
);
log(`    cache pollution: ${polluted ? "❌ STILL POLLUTED" : "✅ clean"}`);

log("\n[4] 返回首页");
await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));

log("\n[5] 第二次点击 大乐透 — 这步用户报错");
const t2 = Date.now();
let secondClickOk = false;
try {
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`    最终 URL = ${page.url()} · ${Date.now() - t2}ms · ✅ OK`);
  secondClickOk = true;
} catch (e) {
  log(`    !! BUG: ${e.message}`);
  log(`    最终 URL = ${page.url()}`);
}

log(`\n[6] 第三次切换（也应该 OK）`);
try {
  await page.goto(`${HOST}/index.html`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 500));
  const navP = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
  await page.click('.lottery-switcher a[href*="dlt"]');
  await navP;
  log(`    最终 URL = ${page.url()} · ✅`);
} catch (e) {
  log(`    !! ${e.message}`);
}

await browser.close();
process.exit(secondClickOk ? 0 : 1);
