// 端到端 puppeteer 验证 A/B 模型对比工作台：
//   1. 启动本地静态服务（5173）
//   2. 打开 SSQ 首页，等待 LSTM panel 准备好
//   3. 用 IndexedDB API 直接 inject 两个不同 seed 的小 SSQ 模型
//      （为什么直接 inject？训练 2 个真模型要 1+ 分钟，这里目标是验证 UI 流程，
//       而单元测试 model-compare.test.mjs 已经覆盖了真训练的对比逻辑）
//   4. 切到 LSTM tab → 点 📂 模型管理 → 勾选两个 → 点击 开始对比
//   5. 等待 #lstmCompareCard 显示，验证 DOM 文本含 "VS" / "BSS" / "test-A" / "test-B"
//   6. 检查 console 无 error

import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 5179;
const BASE = `http://127.0.0.1:${PORT}`;

// 启动 serve.mjs
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
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // 忽略已知 SW 路径警告 / 网络日志
      if (!/sw|service worker|favicon/i.test(text)) {
        errors.push(text);
      }
    }
  });
  page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

  console.log(`[1] open ${BASE}/index.html`);
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });

  // 等到 controller 注册完
  await page.waitForFunction(() => !!document.querySelector("#btnLstmManager"), { timeout: 10000 });

  // 训练两个真实小 SSQ 模型 in-page，存到 IndexedDB
  console.log(`[2] in-page 训练两个小模型并写入 IndexedDB（约 8-12 秒）`);
  const trainResult = await page.evaluate(async () => {
    const ssqMod = await import("./assets/js/nn-ssq-model.js");
    const trainerMod = await import("./assets/js/nn-trainer.js");
    const rngMod = await import("./assets/js/rng.js");
    const storage = await import("./assets/js/model-storage.js");
    const dataMod = await import("./assets/js/data.js");

    const draws = (await dataMod.loadDraws()).draws.slice(-180);
    const samples = trainerMod.buildSamples(draws, 10);
    const split = Math.floor(samples.length * 0.85);
    const trainSamples = samples.slice(0, split);
    const valSamples = samples.slice(split);

    async function buildOne(seed) {
      const rng = rngMod.createRng(seed).next;
      const m = ssqMod.createModel({ hiddenDim: 12, numLayers: 1, rng });
      const r = await trainerMod.trainModel(m, trainSamples, valSamples, {
        epochs: 2, batchSize: 32, lr: 5e-3,
        gradClip: 5, patience: 3, weightDecay: 1e-5,
        labelSmoothing: 0.05, rng,
      });
      return {
        type: "single",
        lottery: "ssq",
        model: ssqMod.serializeModel(m),
        history: r.history,
        seqLen: 10,
        hiddenDim: 12,
        numLayers: 1,
        savedAt: new Date().toISOString(),
      };
    }

    const a = await buildOne("seed-A-2026-cmp");
    const b = await buildOne("seed-B-2026-cmp");
    await storage.save("test-A", a);
    await storage.save("test-B", b);
    const items = await storage.list();
    return { count: items.length, keys: items.map((x) => x.key) };
  });
  console.log(`     [OK] saved ${trainResult.count} models: ${trainResult.keys.join(", ")}`);

  if (!trainResult.keys.includes("test-A") || !trainResult.keys.includes("test-B")) {
    throw new Error("test-A / test-B 未保存到 IndexedDB");
  }

  // 切到 LSTM tab
  console.log(`[3] 切换到 LSTM tab`);
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll("[role='tab'], .tab"))
      .find((el) => el.textContent.includes("LSTM") || el.dataset?.target === "lstm" || el.getAttribute("data-target") === "panel-lstm");
    if (tab) tab.click();
  });
  await sleep(300);

  // 点击 📂 模型管理
  console.log(`[4] 点击模型管理`);
  await page.evaluate(() => {
    document.querySelector("#btnLstmManager")?.click();
  });
  await page.waitForFunction(() => {
    const dlg = document.querySelector(".model-manager-dialog");
    return dlg && dlg.open;
  }, { timeout: 5000 });

  // 勾选两个 checkbox
  console.log(`[5] 勾选 test-A 和 test-B`);
  const beforeCheck = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".mm-item"));
    return items.map((it) => ({
      key: it.dataset.key,
      hasCheckbox: !!it.querySelector("input[type='checkbox'][data-cmp-key]"),
    }));
  });
  console.log(`     mm-items: ${JSON.stringify(beforeCheck)}`);

  const checkResult = await page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll("input[type='checkbox'][data-cmp-key]"));
    const targets = cbs.filter((cb) => cb.dataset.cmpKey === "test-A" || cb.dataset.cmpKey === "test-B");
    targets.forEach((cb) => {
      cb.click();
    });
    return { clicked: targets.length, allCheckboxes: cbs.length };
  });
  console.log(`     clicked ${checkResult.clicked} of ${checkResult.allCheckboxes} checkboxes`);
  await sleep(100);

  const goBtnState = await page.evaluate(() => {
    const btn = document.querySelector("#mmCompareGo");
    return { disabled: btn?.disabled, text: btn?.textContent };
  });
  console.log(`     compare button state = ${JSON.stringify(goBtnState)}`);

  if (goBtnState.disabled) {
    throw new Error("勾选 2 个后 #mmCompareGo 仍 disabled");
  }

  // 点击 开始对比
  console.log(`[6] 点击 开始对比`);
  await page.evaluate(() => {
    document.querySelector("#mmCompareGo")?.click();
  });

  // 等 #lstmCompareCard 显示
  console.log(`[7] 等待对比结果渲染（最多 60 秒）`);
  await page.waitForFunction(() => {
    const card = document.querySelector("#lstmCompareCard");
    if (!card || card.style.display === "none") return false;
    const body = document.querySelector("#lstmCompareBody");
    return body && (body.textContent.includes("VS") || body.textContent.includes("置换") || body.textContent.includes("BSS"));
  }, { timeout: 60000 });

  const cardInfo = await page.evaluate(() => {
    const card = document.querySelector("#lstmCompareCard");
    const body = document.querySelector("#lstmCompareBody");
    const text = body?.textContent || "";
    return {
      cardVisible: card?.style.display !== "none",
      bodyLength: body?.innerHTML?.length || 0,
      hasVS: text.includes("VS"),
      hasBSS: text.includes("BSS") || text.includes("Brier"),
      hasPerm: text.includes("置换") || text.includes("permut"),
      hasA: text.includes("test-A"),
      hasB: text.includes("test-B"),
      hasSvg: !!body?.querySelector("svg"),
      svgCount: body?.querySelectorAll("svg")?.length ?? 0,
    };
  });

  console.log(`     [对比结果]`);
  console.log(`       cardVisible : ${cardInfo.cardVisible}`);
  console.log(`       bodyLength  : ${cardInfo.bodyLength} bytes`);
  console.log(`       hasVS       : ${cardInfo.hasVS}`);
  console.log(`       hasBSS      : ${cardInfo.hasBSS}`);
  console.log(`       hasPerm     : ${cardInfo.hasPerm}`);
  console.log(`       hasA(test-A): ${cardInfo.hasA}`);
  console.log(`       hasB(test-B): ${cardInfo.hasB}`);
  console.log(`       svgCount    : ${cardInfo.svgCount}`);

  const checks = [
    ["card visible", cardInfo.cardVisible],
    ["body content >2KB", cardInfo.bodyLength > 2000],
    ["has VS", cardInfo.hasVS],
    ["has BSS", cardInfo.hasBSS],
    ["has 置换", cardInfo.hasPerm],
    ["has test-A", cardInfo.hasA],
    ["has test-B", cardInfo.hasB],
    ["has SVG curves", cardInfo.svgCount >= 2],
  ];

  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`     ${ok ? "✓" : "✗"} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n[8] 控制台错误数：${errors.length}`);
  errors.forEach((e) => console.log(`     ! ${e}`));

  if (pass !== checks.length) {
    console.log(`\n[FAIL] ${pass}/${checks.length} checks passed`);
    exitCode = 1;
  } else if (errors.length > 0) {
    console.log(`\n[FAIL] DOM 检查全过，但有 ${errors.length} 个 console.error`);
    exitCode = 1;
  } else {
    console.log(`\n[PASS] ${pass}/${checks.length} 全过 · 0 错误`);
  }

  // 清理：删 IndexedDB 测试 key
  await page.evaluate(async () => {
    const storage = await import("./assets/js/model-storage.js");
    await storage.remove("test-A");
    await storage.remove("test-B");
  });

  await browser.close();
} catch (err) {
  console.error(`\n[ERROR] ${err.message}`);
  console.error(err.stack);
  exitCode = 1;
} finally {
  server.kill();
  process.exit(exitCode);
}
