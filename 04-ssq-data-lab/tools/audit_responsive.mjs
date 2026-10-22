// 全面响应式 audit：4 个视口 × 2 个入口 × 多个 tab，截图 + 测量关键尺寸
import puppeteer from "puppeteer-core";
import fs from "node:fs/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const HOST = "http://localhost:5173";
const OUT = "tools/screenshots";
await fs.mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "mobile-360", width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: "mobile-414", width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: "desktop-1280", width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];

const PAGES = [
  { path: "/index.html", id: "ssq", tabs: ["overview", "trend", "distribution", "lstm", "generator", "tools"] },
  { path: "/dlt.html", id: "dlt", tabs: ["overview", "trend", "distribution", "lstm", "generator", "prize", "chase", "tools"] },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const issues = [];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  if (vp.isMobile) {
    await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  }

  for (const pageDef of PAGES) {
    console.log(`\n=== ${vp.name} × ${pageDef.id} ===`);
    try {
      await page.goto(`${HOST}${pageDef.path}`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (e) {
      console.log(`  load failed: ${e.message}`);
      continue;
    }
    await new Promise(r => setTimeout(r, 600));

    // 测量关键尺寸
    const measurements = await page.evaluate(() => {
      const m = {};
      const $ = (s) => document.querySelector(s);
      const r = (el) => el ? el.getBoundingClientRect() : null;
      const nav = $(".tabs");
      m.tabsScrollWidth = nav?.scrollWidth;
      m.tabsClientWidth = nav?.clientWidth;
      m.tabsOverflows = nav ? nav.scrollWidth > nav.clientWidth : null;
      m.topbarHeight = $(".topbar")?.getBoundingClientRect().height;
      m.heroHeight = $(".hero")?.getBoundingClientRect().height;
      m.bodyScrollWidth = document.documentElement.scrollWidth;
      m.bodyClientWidth = document.documentElement.clientWidth;
      m.hasHorizontalOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      // 球
      const ball = document.querySelector(".ball");
      m.ballSize = ball ? Math.round(ball.getBoundingClientRect().width) : null;
      // 第一个 card
      m.firstCardWidth = Math.round(document.querySelector(".panel-grid .card")?.getBoundingClientRect().width || 0);
      // 顶栏元素是否换行/重叠
      const topbar = $(".topbar");
      const topbarChildren = topbar ? Array.from(topbar.children).map(c => ({
        cls: c.className.split(" ")[0],
        rect: r(c),
      })) : [];
      m.topbarRows = new Set(topbarChildren.map(c => Math.round(c.rect?.top || 0))).size;
      m.topbarLayout = topbarChildren.map(c => `${c.cls}@y${Math.round(c.rect?.top || 0)}`);
      // 倒计时 grid
      const cd = $(".countdown-grid");
      if (cd) {
        const cells = cd.querySelectorAll(".cd-cell");
        m.countdownCells = cells.length;
        m.countdownRows = new Set(Array.from(cells).map(c => Math.round(c.getBoundingClientRect().top))).size;
      }
      // 切换器（lottery-switcher）
      m.switcherWidth = Math.round($(".lottery-switcher")?.getBoundingClientRect().width || 0);
      // 检查文字是否被截断或溢出
      const overflowingText = [];
      document.querySelectorAll("h1, h2, .card-title, .meta, .hero-eyebrow, .name, .brand-text").forEach(el => {
        if (el.scrollWidth > el.clientWidth + 1) {
          overflowingText.push({
            sel: el.tagName + "." + el.className.split(" ")[0],
            text: (el.textContent || "").slice(0, 30),
            scrollW: el.scrollWidth,
            clientW: el.clientWidth,
          });
        }
      });
      m.overflowingTexts = overflowingText.slice(0, 10);
      return m;
    });

    console.log(`  ${JSON.stringify(measurements, null, 2).split("\n").map(l => "  " + l).join("\n")}`);

    if (measurements.hasHorizontalOverflow) {
      issues.push(`${vp.name} × ${pageDef.id}: 横向溢出 (body=${measurements.bodyScrollWidth} > ${measurements.bodyClientWidth})`);
    }
    if (measurements.overflowingTexts?.length) {
      for (const t of measurements.overflowingTexts) {
        issues.push(`${vp.name} × ${pageDef.id}: 文字溢出 ${t.sel}: "${t.text}" (${t.scrollW}>${t.clientW})`);
      }
    }

    const shotPath = `${OUT}/${vp.name}-${pageDef.id}-overview.png`;
    await page.screenshot({ path: shotPath, fullPage: false });
    console.log(`  📸 ${shotPath}`);

    // 跑一遍 tabs 点击
    for (const tab of pageDef.tabs.slice(1, 4)) {
      const ok = await page.evaluate((t) => {
        const btn = document.querySelector(`.tab[data-tab="${t}"]`);
        if (btn) { btn.click(); return true; }
        return false;
      }, tab);
      if (ok) {
        await new Promise(r => setTimeout(r, 400));
        const tabShot = `${OUT}/${vp.name}-${pageDef.id}-${tab}.png`;
        await page.screenshot({ path: tabShot, fullPage: false });
        console.log(`  📸 ${tabShot}`);
      }
    }
  }
  await page.close();
}

await browser.close();

console.log(`\n\n=== 发现的问题 (${issues.length}) ===`);
for (const issue of issues) console.log(`  • ${issue}`);
process.exit(0);
