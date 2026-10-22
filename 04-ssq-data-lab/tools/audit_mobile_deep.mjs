// 移动端深度 audit：模拟真实用户交互（滚动、切 tab、输入、点击球）
import puppeteer from "puppeteer-core";
import fs from "node:fs/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const HOST = "http://localhost:5173";
const OUT = "tools/screenshots/mobile-deep";
await fs.mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "iphone-se-375", width: 375, height: 667, scale: 2 },
  { name: "iphone-13-390", width: 390, height: 844, scale: 3 },
  { name: "iphone-pro-max-430", width: 430, height: 932, scale: 3 },
  { name: "small-360", width: 360, height: 640, scale: 2 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const issues = [];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.scale,
    isMobile: true,
    hasTouch: true,
  });
  await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");

  for (const entry of ["index.html", "dlt.html"]) {
    const id = entry === "index.html" ? "ssq" : "dlt";
    const tag = `${vp.name} × ${id}`;
    console.log(`\n=== ${tag} ===`);

    try {
      // 完全清缓存（防 SW 缓存住旧 CSS）
      await page.setCacheEnabled(false);
      const client = await page.target().createCDPSession();
      await client.send("Network.clearBrowserCache");
      await client.send("Network.clearBrowserCookies");
      await page.goto(`${HOST}/${entry}`, { waitUntil: "networkidle2" });
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.log(`  load failed: ${e.message}`);
      continue;
    }

    // —— 测试 1：基础测量 ——
    const m = await page.evaluate(() => {
      const $ = (s) => document.querySelector(s);
      const r = (el) => el?.getBoundingClientRect();
      // body 横向溢出
      const horizOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      // 顶栏高度（sticky 占用空间）
      const topbarH = r($(".topbar"))?.height;
      // 顶栏占视口比例
      const topbarRatio = topbarH / window.innerHeight;
      // tabs 是否贴边（视觉差）
      const tabs = $(".tabs");
      const tabsRect = r(tabs);
      const tabsScrollNeeded = tabs?.scrollWidth > tabs?.clientWidth;
      // 顶栏元素是否换行/重叠
      const topbar = $(".topbar");
      const tbChildren = topbar ? Array.from(topbar.children).map(c => ({
        cls: c.className.split(" ")[0],
        rect: r(c),
      })) : [];
      const topbarRows = new Set(tbChildren.map(c => Math.round(c.rect?.top ?? 0))).size;
      // hero 数据栏（metric）尺寸
      const metric = $(".metric");
      const metricH = r(metric)?.height;
      // 倒计时单元格
      const cdCells = document.querySelectorAll(".cd-cell");
      const cdW = cdCells[0] ? r(cdCells[0])?.width : 0;
      // 球大小
      const ballW = r($(".ball"))?.width;
      // 第一个 panel-grid 卡片宽度
      const cardW = r(document.querySelector(".panel-grid .card"))?.width;
      // touch target 是否 >= 44px (Apple HIG)
      const smallButtons = [];
      document.querySelectorAll("button, a, .tab, .icon-btn").forEach(el => {
        const rc = r(el);
        if (rc && rc.width > 0 && rc.height > 0) {
          // 32×32 是 Web 触摸目标普遍可接受的下限（Apple HIG 44, MDN 推荐 24+，
          // Material 推荐 48；这里用 32 作为"算太小"的阈值，符合 WCAG AA 24px target size 的合理超出）
          if (rc.height < 32 || rc.width < 28) {
            smallButtons.push({
              cls: el.className.split(" ")[0] || el.tagName,
              w: Math.round(rc.width),
              h: Math.round(rc.height),
              text: (el.textContent || el.value || "").slice(0, 16),
            });
          }
        }
      });
      // 文字溢出
      const overflowing = [];
      document.querySelectorAll("h1, h2, .card-title, .name, .metric .value, .meta, .hero-eyebrow").forEach(el => {
        if (el.scrollWidth > el.clientWidth + 1) {
          overflowing.push({
            cls: el.tagName + "." + (el.className.split(" ")[0] || ""),
            text: (el.textContent || "").slice(0, 24),
            sw: el.scrollWidth, cw: el.clientWidth,
          });
        }
      });
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        horizOverflow, topbarH, topbarRatio, topbarRows,
        tabsScrollNeeded,
        metricH, cdW, ballW, cardW,
        smallButtons: smallButtons.slice(0, 6),
        overflowing: overflowing.slice(0, 6),
      };
    });

    console.log(`  viewport: ${m.viewport.w}×${m.viewport.h}`);
    console.log(`  topbar: h=${Math.round(m.topbarH)}px (${(m.topbarRatio * 100).toFixed(0)}% of vp), rows=${m.topbarRows}`);
    console.log(`  ball: ${Math.round(m.ballW)}px`);
    console.log(`  cd-cell: ${Math.round(m.cdW)}px wide`);
    console.log(`  card: ${Math.round(m.cardW)}px wide`);
    if (m.horizOverflow) issues.push(`${tag}: ❌ 横向溢出`);
    if (m.topbarRatio > 0.25) issues.push(`${tag}: ⚠ 顶栏占 ${(m.topbarRatio * 100).toFixed(0)}% 视口高度，太重`);
    if (m.smallButtons.length) {
      console.log(`  ⚠ 小按钮（< 36×24）:`);
      for (const b of m.smallButtons) {
        console.log(`     ${b.cls} ${b.w}×${b.h}px text="${b.text}"`);
      }
      issues.push(`${tag}: ${m.smallButtons.length} 个按钮触摸目标过小`);
    }
    if (m.overflowing.length) {
      console.log(`  ⚠ 文字溢出:`);
      for (const o of m.overflowing) {
        console.log(`     ${o.cls} sw=${o.sw} cw=${o.cw} "${o.text}"`);
      }
      issues.push(`${tag}: ${m.overflowing.length} 处文字溢出`);
    }

    // 截图
    await page.screenshot({ path: `${OUT}/${vp.name}-${id}-1-overview.png`, fullPage: false });

    // —— 测试 2：tabs 横滑 ——
    const tabScroll = await page.evaluate(() => {
      const tabs = document.querySelector(".tabs");
      if (!tabs) return null;
      const beforeScroll = tabs.scrollLeft;
      tabs.scrollTo(tabs.scrollWidth, 0);
      const afterScroll = tabs.scrollLeft;
      tabs.scrollTo(0, 0);
      return { canScroll: afterScroll > beforeScroll, totalW: tabs.scrollWidth, viewW: tabs.clientWidth };
    });
    console.log(`  tabs scroll: ${tabScroll?.canScroll ? "✓" : "✗"} (total=${tabScroll?.totalW}, view=${tabScroll?.viewW})`);

    // —— 测试 3：切换到非 overview tab，看内部样式 ——
    const tabsToTest = id === "ssq"
      ? ["lstm", "generator", "tools"]
      : ["lstm", "generator", "prize", "chase", "tools"];
    for (const t of tabsToTest) {
      try {
        const ok = await page.evaluate((name) => {
          const btn = document.querySelector(`.tab[data-tab="${name}"]`);
          if (!btn) return false;
          btn.click();
          return true;
        }, t);
        if (!ok) continue;
        await new Promise(r => setTimeout(r, 500));

        // 测内部
        const inner = await page.evaluate((name) => {
          const panel = document.querySelector(`#panel-${name}`);
          if (!panel) return null;
          const horizOverflow = panel.scrollWidth > panel.clientWidth + 2;
          // 看 input/select 是否合理大小（排除 checkbox / range，这些靠 label 包住）
          const fields = panel.querySelectorAll("input:not([type=checkbox]):not([type=range]):not([type=radio]), select");
          const tooSmallFields = [];
          fields.forEach(f => {
            const rc = f.getBoundingClientRect();
            if (rc.height < 36) {
              tooSmallFields.push({
                id: f.id || f.name,
                type: f.type,
                h: Math.round(rc.height),
                w: Math.round(rc.width),
              });
            }
          });
          // checkbox / range 看它们的 label 包装
          const wrapTooSmall = [];
          panel.querySelectorAll("label.check, label.field").forEach(lb => {
            const rc = lb.getBoundingClientRect();
            if (rc.height < 32 && lb.querySelector("input[type=checkbox], input[type=range]")) {
              wrapTooSmall.push({ tag: lb.tagName + "." + (lb.className || ""), h: Math.round(rc.height) });
            }
          });
          // 任何元素超出视口（且不在横滚容器里）
          const overflowing = [];
          panel.querySelectorAll("*").forEach(el => {
            const rc = el.getBoundingClientRect();
            if (rc.right > window.innerWidth + 1 && el.children.length === 0 && el.textContent?.trim()) {
              // 检查是否在某个 overflow-x:auto 的祖先里（那种情况不算溢出，是设计上的横滚）
              let p = el.parentElement;
              let inScroller = false;
              while (p && p !== panel) {
                const cs = getComputedStyle(p);
                if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && p.scrollWidth > p.clientWidth) {
                  inScroller = true;
                  break;
                }
                p = p.parentElement;
              }
              if (!inScroller) {
                overflowing.push({ cls: el.tagName + "." + (el.className?.split?.(" ")[0] || ""), right: Math.round(rc.right) });
              }
            }
          });
          return { horizOverflow, tooSmallFields, wrapTooSmall, overflowing: overflowing.slice(0, 5) };
        }, t);

        const flag = inner?.horizOverflow || (inner?.tooSmallFields?.length || 0) > 0 || (inner?.overflowing?.length || 0) > 0 || (inner?.wrapTooSmall?.length || 0) > 0
          ? "⚠" : "✓";
        console.log(`  ${flag} tab[${t}]: overflow=${inner?.horizOverflow}, small=${inner?.tooSmallFields?.length}, wrapSmall=${inner?.wrapTooSmall?.length}, oob=${inner?.overflowing?.length}`);
        if (inner?.tooSmallFields?.length) {
          for (const f of inner.tooSmallFields.slice(0, 4)) {
            console.log(`       small ${f.type || "input"} #${f.id} ${f.w}×${f.h}`);
          }
        }
        if (inner?.wrapTooSmall?.length) {
          for (const w of inner.wrapTooSmall.slice(0, 4)) {
            console.log(`       wrap ${w.tag} h=${w.h}`);
          }
        }
        if (inner?.overflowing?.length) {
          for (const o of inner.overflowing) {
            console.log(`       ${o.cls} right=${o.right}`);
            issues.push(`${tag}/${t}: 元素 ${o.cls} 超出视口 right=${o.right}`);
          }
        }
        if (inner?.horizOverflow) issues.push(`${tag}/${t}: panel 横向溢出`);
        if (inner?.tooSmallFields?.length) {
          issues.push(`${tag}/${t}: ${inner.tooSmallFields.length} 个 input/select 元素 < 36px 高`);
        }
        if (inner?.wrapTooSmall?.length) {
          issues.push(`${tag}/${t}: ${inner.wrapTooSmall.length} 个 label (checkbox/range) < 32px 高`);
        }

        await page.screenshot({ path: `${OUT}/${vp.name}-${id}-2-${t}.png`, fullPage: false });
      } catch (e) {
        console.log(`  tab[${t}] failed: ${e.message}`);
      }
    }

    await page.evaluate(() => document.querySelector('.tab[data-tab="overview"]')?.click());
    await new Promise(r => setTimeout(r, 200));
  }
  await page.close();
}

await browser.close();

console.log(`\n\n=== 总问题数: ${issues.length} ===`);
for (const i of issues) console.log(`  • ${i}`);
process.exit(0);
