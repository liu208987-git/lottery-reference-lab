import puppeteer from "puppeteer-core";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
await page.goto("http://localhost:5173/index.html", { waitUntil: "networkidle2" });

const r = await page.evaluate(() => {
  const a = Array.from(document.querySelectorAll(".footer a")).find(x => x.textContent === "GitHub");
  if (!a) return null;
  const cs = getComputedStyle(a);
  const rect = a.getBoundingClientRect();
  return {
    rect: { w: rect.width, h: rect.height },
    padding: cs.padding,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    minHeight: cs.minHeight,
    display: cs.display,
    lineHeight: cs.lineHeight,
    fontSize: cs.fontSize,
    cssText: a.style.cssText,
    parent: {
      display: getComputedStyle(a.parentElement).display,
      flexWrap: getComputedStyle(a.parentElement).flexWrap,
    },
    matchedRules: window.innerWidth,
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
