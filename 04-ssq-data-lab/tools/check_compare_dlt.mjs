// DLT 版 A/B 对比端到端验证
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5180;
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`[setup] starting static server on ${PORT}`);
const server = spawn("node", ["tools/serve.mjs", String(PORT)], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (b) => process.stdout.write(`[server] ${b}`));
server.stderr.on("data", (b) => process.stderr.write(`[server] ${b}`));
await sleep(800);

let exitCode = 0;
try {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (!/sw|service worker|favicon/i.test(t)) errors.push(t);
    }
  });
  page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

  console.log(`[1] open ${BASE}/dlt.html`);
  await page.goto(`${BASE}/dlt.html`, { waitUntil: "networkidle2", timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector("#btnDltLstmManager"), { timeout: 10000 });

  console.log(`[2] 训练 2 个 DLT 小模型`);
  const trainResult = await page.evaluate(async () => {
    const m = await import("./assets/js/dlt-nn-model.js");
    const t = await import("./assets/js/dlt-nn-trainer.js");
    const rngMod = await import("./assets/js/rng.js");
    const storage = await import("./assets/js/model-storage.js");
    const dataMod = await import("./assets/js/dlt-data.js");

    const draws = (await dataMod.loadDltDraws()).draws.slice(-180);
    const samples = t.buildDltSamples(draws, 10);
    const split = Math.floor(samples.length * 0.85);
    const trainSamples = samples.slice(0, split);
    const valSamples = samples.slice(split);

    async function buildOne(seed) {
      const rng = rngMod.createRng(seed).next;
      const model = m.createDltModel({ hiddenDim: 12, numLayers: 1, rng });
      const r = await t.trainDltModel(model, trainSamples, valSamples, {
        epochs: 2, batchSize: 32, lr: 5e-3,
        gradClip: 5, patience: 3, weightDecay: 1e-5,
        labelSmoothing: 0.05, rng,
      });
      return {
        type: "single", lottery: "dlt",
        model: m.serializeDltModel(model),
        history: r.history,
        seqLen: 10, hiddenDim: 12, numLayers: 1,
        savedAt: new Date().toISOString(),
      };
    }
    const a = await buildOne("dlt-A-2026-cmp");
    const b = await buildOne("dlt-B-2026-cmp");
    await storage.save("dlt-test-A", a);
    await storage.save("dlt-test-B", b);
    return { keys: (await storage.list()).map((x) => x.key) };
  });
  console.log(`     [OK] keys: ${trainResult.keys.join(", ")}`);

  console.log(`[3] 切到 LSTM tab`);
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
      .find((el) => el.textContent.includes("LSTM"));
    if (tab) tab.click();
  });
  await sleep(300);

  console.log(`[4] 打开模型管理`);
  await page.evaluate(() => document.querySelector("#btnDltLstmManager")?.click());
  await page.waitForFunction(() => {
    const dlg = document.querySelector(".model-manager-dialog");
    return dlg && dlg.open;
  }, { timeout: 5000 });

  console.log(`[5] 勾选 dlt-test-A 和 dlt-test-B`);
  await page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll("input[type='checkbox'][data-cmp-key]"));
    cbs.filter((cb) => cb.dataset.cmpKey === "dlt-test-A" || cb.dataset.cmpKey === "dlt-test-B")
      .forEach((cb) => cb.click());
  });
  await sleep(100);

  console.log(`[6] 开始对比`);
  await page.evaluate(() => document.querySelector("#mmCompareGo")?.click());

  console.log(`[7] 等待 #dltLstmCompareCard 渲染`);
  await page.waitForFunction(() => {
    const card = document.querySelector("#dltLstmCompareCard");
    if (!card || card.style.display === "none") return false;
    const body = document.querySelector("#dltLstmCompareBody");
    return body && (body.textContent.includes("VS") || body.textContent.includes("BSS"));
  }, { timeout: 60000 });

  const info = await page.evaluate(() => {
    const card = document.querySelector("#dltLstmCompareCard");
    const body = document.querySelector("#dltLstmCompareBody");
    const text = body?.textContent || "";
    return {
      cardVisible: card?.style.display !== "none",
      bodyLength: body?.innerHTML?.length || 0,
      hasVS: text.includes("VS"),
      hasBSS: text.includes("BSS") || text.includes("Brier"),
      hasPerm: text.includes("置换") || text.includes("permut"),
      hasA: text.includes("dlt-test-A"),
      hasB: text.includes("dlt-test-B"),
      svgCount: body?.querySelectorAll("svg")?.length ?? 0,
      hasFrontHit5: text.includes("hit@5") || text.includes("Hit@5") || text.includes("前区"),
    };
  });

  console.log(`     [DLT 对比结果]`);
  for (const [k, v] of Object.entries(info)) {
    console.log(`       ${k.padEnd(14)}: ${v}`);
  }

  const checks = [
    ["card visible", info.cardVisible],
    ["body >2KB", info.bodyLength > 2000],
    ["has VS", info.hasVS],
    ["has BSS", info.hasBSS],
    ["has 置换", info.hasPerm],
    ["has dlt-test-A", info.hasA],
    ["has dlt-test-B", info.hasB],
    ["≥2 SVG", info.svgCount >= 2],
    ["has 前区/hit@5", info.hasFrontHit5],
  ];
  let pass = 0;
  for (const [n, ok] of checks) {
    console.log(`     ${ok ? "✓" : "✗"} ${n}`);
    if (ok) pass++;
  }
  console.log(`\n[8] console.error: ${errors.length}`);
  errors.forEach((e) => console.log(`     ! ${e}`));

  if (pass !== checks.length || errors.length) {
    console.log(`\n[FAIL] ${pass}/${checks.length}, errors=${errors.length}`);
    exitCode = 1;
  } else {
    console.log(`\n[PASS] DLT ${pass}/${checks.length} · 0 错误`);
  }

  await page.evaluate(async () => {
    const s = await import("./assets/js/model-storage.js");
    await s.remove("dlt-test-A"); await s.remove("dlt-test-B");
  });
  await browser.close();
} catch (err) {
  console.error(`\n[ERROR] ${err.message}`); console.error(err.stack);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
