// Lottery Data Lab · service worker
//
// 设计目标：
//   1. 离线可用：缓存 app shell（HTML/CSS/JS）
//   2. 数据保鲜：data/draws.json / data/dlt-draws.json 走 stale-while-revalidate
//   3. 不缓存第三方：仅同源资源
//
// 关键陷阱（v10 修复）：
//   ── 不能把"被重定向过的 Response"放进 cache。──
//   按 Fetch 规范，SW 把 redirected==true 的响应返回给浏览器会触发 TypeError，
//   表现为 ERR_FAILED。踩坑场景：
//     APP_SHELL 里写了 "./dlt.html"，但 Cloudflare Pages 把 /dlt.html 308 →
//     /dlt，于是 cache.add("/dlt.html") 缓存到的是 redirected=true 的响应。
//     第二次访问 dlt.html 时 SW 命中缓存返回，浏览器拒绝并抛 ERR_FAILED。
//
//   v9 试图用 new Response(blob, ...) 重建剥掉 redirected 标记，但这样
//   产出的 Response.type === "default"（不是 "basic"），有时 Chrome 又会
//   在 navigation 上对 type=default 的响应起疑，再次 ERR_FAILED。
//
//   v10 简化策略：
//     a) 把 HTML 文档（index.html / dlt.html）从预缓存清单里去掉 ——
//        反正 navigation 是 network-first，第一次访问就会被缓存
//     b) HTML navigation 全部走 network-first：每次点击都拿网络上最新的
//        最终文档，cache 只是离线兜底
//     c) 缓存命中前先校验 redirected==false，否则丢弃重新拉
//     d) 静态资源（JS/CSS）走 cache-first，但同样校验 redirected

const CACHE_VERSION = "ssq-lab-v23";
const APP_SHELL = [
  "./assets/styles.css",
  "./assets/dlt-styles.css",
  "./assets/js/advanced-sampler.js",
  "./assets/js/bayes.js",
  "./assets/js/bayesian-averaging.js",
  "./assets/js/bca-bootstrap.js",
  "./assets/js/block-bootstrap.js",
  "./assets/js/chart.js",
  "./assets/js/chi-square.js",
  "./assets/js/combinatorics.js",
  "./assets/js/conformal-ui.js",
  "./assets/js/conformal.js",
  "./assets/js/cooccurrence.js",
  "./assets/js/countdown.js",
  "./assets/js/dantuo-prize.js",
  "./assets/js/data.js",
  "./assets/js/distance.js",
  "./assets/js/distribution.js",
  "./assets/js/dlt-advanced-sampler.js",
  "./assets/js/dlt-backtest.js",
  "./assets/js/dlt-chart.js",
  "./assets/js/dlt-chase.js",
  "./assets/js/dlt-chi-square.js",
  "./assets/js/dlt-combinatorics.js",
  "./assets/js/dlt-cooccurrence.js",
  "./assets/js/dlt-countdown.js",
  "./assets/js/dlt-data.js",
  "./assets/js/dlt-distribution.js",
  "./assets/js/dlt-explainer.js",
  "./assets/js/dlt-generator.js",
  "./assets/js/dlt-independence.js",
  "./assets/js/dlt-lstm-controller.js",
  "./assets/js/dlt-main.js",
  "./assets/js/dlt-nn-backtest.js",
  "./assets/js/dlt-nn-ensemble.js",
  "./assets/js/dlt-nn-model.js",
  "./assets/js/dlt-nn-trainer.js",
  "./assets/js/dlt-prize.js",
  "./assets/js/dlt-timeseries.js",
  "./assets/js/dlt-trend-chart.js",
  "./assets/js/dlt-ui.js",
  "./assets/js/dpp.js",
  "./assets/js/drift-monitor-ui.js",
  "./assets/js/generator.js",
  "./assets/js/lottery-config.js",
  "./assets/js/lottery-stats.js",
  "./assets/js/lstm-backtest-renderer.js",
  "./assets/js/lstm-controller.js",
  "./assets/js/lstm-explainer-card.js",
  "./assets/js/main.js",
  "./assets/js/mcmc.js",
  "./assets/js/miss-stats.js",
  "./assets/js/model-compare.js",
  "./assets/js/model-manager-ui.js",
  "./assets/js/model-storage.js",
  "./assets/js/mondrian-conformal.js",
  "./assets/js/nn-backtest.js",
  "./assets/js/nn-calibration.js",
  "./assets/js/nn-ensemble.js",
  "./assets/js/nn-features.js",
  "./assets/js/nn-lstm.js",
  "./assets/js/nn-math.js",
  "./assets/js/nn-optim.js",
  "./assets/js/nn-schedule.js",
  "./assets/js/nn-ssq-model.js",
  "./assets/js/nn-stack.js",
  "./assets/js/nn-statistics.js",
  "./assets/js/nn-trainer.js",
  "./assets/js/nn-worker-client.js",
  "./assets/js/prediction-history.js",
  "./assets/js/prediction-tracker-ui.js",
  "./assets/js/psi.js",
  "./assets/js/rational-betting-ui.js",
  "./assets/js/rational-betting.js",
  "./assets/js/rng.js",
  "./assets/js/ssq-backtest.js",
  "./assets/js/ssq-betting-ui.js",
  "./assets/js/ssq-chase.js",
  "./assets/js/ssq-explainer.js",
  "./assets/js/ssq-prize.js",
  "./assets/js/stability-selection.js",
  "./assets/js/stats.js",
  "./assets/js/timeseries.js",
  "./assets/js/trend-chart.js",
  "./assets/js/trend.js",
  "./assets/js/ui.js",
  "./assets/js/utils.js",
  "./manifest.webmanifest",
  "./data/demo-models/ssq-lstm.json",
  "./data/demo-models/dlt-lstm.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // 单文件失败不阻塞 SW 安装；不缓存 HTML（navigation 走 network-first）
      await Promise.all(
        APP_SHELL.map(async (url) => {
          try {
            // 这些都是不会被 redirect 的资源，可以直接 cache.add
            const res = await fetch(url, { credentials: "same-origin" });
            if (res.ok && !res.redirected) {
              await cache.put(url, res);
            }
          } catch (e) {
            // ignore
          }
        })
      );
      // 注意：不再 skipWaiting()。让新 SW 进入 waiting 状态，
      // 主线程检测到后会显示"有更新"横幅，用户点击后再 skipWaiting。
      // 第一次访问时（无 controller）让它直接接管：
      if (!self.registration?.active) {
        self.skipWaiting();
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// 主线程发 { type: "SKIP_WAITING" } 时，立刻接管（用户点"立即更新"按钮触发）
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // 0) Web Worker 脚本：直接走网络，不让 SW 干预
  //    （SW 包装的 Response 在 Worker 里有时会出 module loading 异常）
  if (url.pathname.endsWith("/nn-trainer-worker.js")) {
    return; // 让浏览器原生 fetch
  }

  // 1) 数据接口：stale-while-revalidate
  if (url.pathname.endsWith("/data/draws.json") || url.pathname.endsWith("/data/dlt-draws.json")) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 2) HTML 文档（navigation）：network-only with offline fallback
  //    永远不缓存，避免 redirected 污染；离线时回退到 cache（也校验 redirected）
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(networkOnlyForNav(req));
    return;
  }

  // 3) 其他静态资源：cache-first
  event.respondWith(cacheFirst(req));
});

/**
 * Navigation：network-only。绝不缓存 HTML，避免 redirected 污染。
 * 网络失败时尝试用 cache 里**显式校验过的**已存条目（旧版 SW 留下的 dlt.html 等）。
 */
async function networkOnlyForNav(req) {
  try {
    return await fetch(req);
  } catch (err) {
    // 离线兜底：找一个干净的（非 redirected）HTML
    const cache = await caches.open(CACHE_VERSION);
    const url = new URL(req.url);
    // 试 dlt.html
    if (url.pathname.includes("/dlt")) {
      const c = await cache.match("./dlt.html");
      if (c && !c.redirected) return c;
    }
    const c = await cache.match("./index.html");
    if (c && !c.redirected) return c;
    return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached && !cached.redirected) return cached;
  if (cached && cached.redirected) {
    // 修复历史污染缓存
    await cache.delete(req);
  }
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok && !res.redirected) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (cached && !cached.redirected) return cached;
  return (await network) || new Response("offline", { status: 503 });
}
