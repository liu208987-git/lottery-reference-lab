// 扫描 assets/js/ 自动生成 sw.js 的 APP_SHELL 列表，注入到 sw.js。
//
// 触发：手动跑（每次新加 JS 模块后）或 pre-commit 钩子。
//
// 产出：sw.js 中 APP_SHELL = [...] 块被自动重写。版本号自动 +1。

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SW_PATH = path.join(ROOT, "sw.js");
const JS_DIR = path.join(ROOT, "assets/js");
const STYLES = ["./assets/styles.css", "./assets/dlt-styles.css"];
const EXTRAS = [
  "./manifest.webmanifest",
  "./data/demo-models/ssq-lstm.json",
  "./data/demo-models/dlt-lstm.json",
];
// 故意排除：worker 脚本不进 cache（SW 包装的 Response 偶尔让 module worker 加载报错）
const EXCLUDE = new Set([
  "nn-trainer-worker.js",
]);

const jsFiles = fs.readdirSync(JS_DIR)
  .filter((f) => f.endsWith(".js") && !EXCLUDE.has(f))
  .sort()
  .map((f) => `./assets/js/${f}`);

const all = [...STYLES, ...jsFiles, ...EXTRAS];

// 读 sw.js
let sw = fs.readFileSync(SW_PATH, "utf8");

// 提升版本号 (vXX → vXX+1)
const versionRe = /const CACHE_VERSION = "ssq-lab-v(\d+)";/;
const m = sw.match(versionRe);
if (!m) {
  console.error("未找到 CACHE_VERSION 行");
  process.exit(1);
}
const oldV = parseInt(m[1], 10);
const newV = oldV + 1;
sw = sw.replace(versionRe, `const CACHE_VERSION = "ssq-lab-v${newV}";`);

// 替换 APP_SHELL 数组
const blockRe = /const APP_SHELL = \[[\s\S]*?\n\];/;
const lines = all.map((p) => `  "${p}",`).join("\n");
const newBlock = `const APP_SHELL = [\n${lines}\n];`;
if (!blockRe.test(sw)) {
  console.error("未找到 APP_SHELL 块");
  process.exit(1);
}
sw = sw.replace(blockRe, newBlock);

fs.writeFileSync(SW_PATH, sw);
console.log(`[OK] sw.js 已更新：${all.length} 资源 · v${oldV} → v${newV}`);
console.log(`     ${jsFiles.length} JS 文件 · ${STYLES.length} CSS · ${EXTRAS.length} 其他`);
