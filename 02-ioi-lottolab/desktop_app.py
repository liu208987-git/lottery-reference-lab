"""Native Windows desktop shell for the IOI lottery quant system."""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path


APP_TITLE = "IOI AI 彩票量化预测系统"


def _application_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


# Set the persistent data location before importing modules that define DB paths.
os.environ.setdefault("LOTTO_DATA_DIR", str(_application_dir()))

import webview  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from web_app import app  # noqa: E402


class LocalServer(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="ioi-local-server", daemon=True)
        self.server = make_server("127.0.0.1", 0, app, threaded=True)
        self.port = self.server.server_port

    def run(self) -> None:
        self.server.serve_forever()

    def shutdown(self) -> None:
        self.server.shutdown()


def main() -> None:
    server = LocalServer()
    server.start()
    try:
        window = webview.create_window(
            APP_TITLE,
            f"http://127.0.0.1:{server.port}/",
            width=1480,
            height=920,
            min_size=(1080, 700),
            background_color="#050914",
        )
        window.events.loaded += lambda: window.evaluate_js(
            "history.scrollRestoration='manual';"
            "window.scrollTo(0,0);"
            "setTimeout(()=>window.scrollTo(0,0),300);"
            "setTimeout(()=>window.scrollTo(0,0),1500);"
        )
        webview.start(debug=False, private_mode=True)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
