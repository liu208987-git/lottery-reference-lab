from __future__ import annotations

import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


LAB_ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


JS_PREFIX = r"""
const assert = require("node:assert/strict");
const share = require("./web/static/share.js");

const prediction = {
  lottery_code: "ssq",
  lottery_name: "双色球",
  issue: "2026083",
  target_date: "2026-07-21",
  zones: {
    front: {
      models: {
        ga_ensemble: { numbers: [5, 7, 10, 14, 21, 28] },
      },
    },
    back: {
      models: {
        ga_ensemble: { numbers: [4] },
      },
    },
  },
};

const blob = new Blob(["png"], { type: "image/png" });
"""


@unittest.skipUnless(NODE, "需要 Node.js 验证浏览器分享模块")
class ShareModuleRegressionTests(unittest.TestCase):
    def run_node(self, body: str) -> None:
        completed = subprocess.run(
            [str(NODE), "-e", JS_PREFIX + textwrap.dedent(body)],
            cwd=LAB_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if completed.returncode != 0:
            self.fail(
                "Node 分享模块回归测试失败\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )

    def test_image_web_share_emits_one_file_only_payload(self) -> None:
        self.run_node(
            r"""
            (async () => {
              const payloads = [];
              const navigator = {
                canShare(payload) {
                  assert.equal(payload.files.length, 1);
                  return true;
                },
                async share(payload) {
                  payloads.push(payload);
                },
              };

              const result = await share.sharePredictionCard(prediction, {
                blob,
                navigator,
              });

              assert.equal(result.method, "web-share");
              assert.equal(payloads.length, 1, "一次点击只能调用一次系统分享");
              assert.equal(payloads[0].files.length, 1, "只能分享一张图片");
              assert.equal(
                Object.hasOwn(payloads[0], "text"),
                false,
                "图片分享不得附带第二份文本载荷",
              );
              assert.equal(
                Object.hasOwn(payloads[0], "title"),
                false,
                "图片分享不得附带会被拷贝目标识别为额外内容的标题载荷",
              );
            })().catch((error) => {
              console.error(error);
              process.exitCode = 1;
            });
            """
        )

    def test_started_web_share_does_not_emit_download_or_clipboard_fallback(self) -> None:
        self.run_node(
            r"""
            (async () => {
              let shareCalls = 0;
              let downloadClicks = 0;
              let clipboardWrites = 0;
              const navigator = {
                canShare() {
                  return true;
                },
                async share() {
                  shareCalls += 1;
                  const error = new Error("系统分享目标返回失败");
                  error.name = "NotAllowedError";
                  throw error;
                },
                clipboard: {
                  async writeText() {
                    clipboardWrites += 1;
                  },
                },
              };
              const document = {
                body: { appendChild() {} },
                createElement(tagName) {
                  assert.equal(tagName, "a");
                  return {
                    style: {},
                    click() {
                      downloadClicks += 1;
                    },
                    remove() {},
                  };
                },
              };
              const URL = {
                createObjectURL() {
                  return "blob:test";
                },
                revokeObjectURL() {},
              };

              try {
                await share.sharePredictionCard(prediction, {
                  blob,
                  navigator,
                  document,
                  URL,
                  setTimeout(callback) {
                    callback();
                  },
                });
              } catch (_error) {
                // 允许实现向调用方报告分享失败；这里只验证没有第二次输出副作用。
              }

              assert.equal(shareCalls, 1, "系统分享只能启动一次");
              assert.equal(downloadClicks, 0, "分享启动后不得再下载第二份图片");
              assert.equal(clipboardWrites, 0, "分享启动后不得再写入第二份剪切板内容");
            })().catch((error) => {
              console.error(error);
              process.exitCode = 1;
            });
            """
        )

    def test_copy_fallback_writes_clipboard_exactly_once(self) -> None:
        self.run_node(
            r"""
            (async () => {
              const writes = [];
              const navigator = {
                clipboard: {
                  async writeText(value) {
                    writes.push(value);
                  },
                },
              };

              const result = await share.sharePredictionCard(prediction, {
                blob,
                navigator,
              });

              assert.equal(result.method, "copy");
              assert.equal(writes.length, 1, "复制兜底只能写入一次剪切板");
              assert.equal(writes[0], "05 07 10 14 21 28 | 04");
            })().catch((error) => {
              console.error(error);
              process.exitCode = 1;
            });
            """
        )


if __name__ == "__main__":
    unittest.main()
