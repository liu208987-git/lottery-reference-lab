#!/usr/bin/env python3
"""Fail when the public repository contains private runtime data or secrets."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


LAB_ROOT = Path(__file__).resolve().parents[1]
SELF_PATH = Path(__file__).resolve()

SKIP_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
}
PRIVATE_CSV_NAMES = {
    "manual_entries.csv",
    "synced_entries.csv",
}
SENSITIVE_EXACT_NAMES = {
    ".env",
    "credentials",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
}
SENSITIVE_SUFFIXES = {
    ".jks",
    ".key",
    ".keystore",
    ".p12",
    ".pem",
    ".pfx",
}
TEXT_SUFFIXES = {
    "",
    ".cfg",
    ".conf",
    ".css",
    ".csv",
    ".dockerignore",
    ".env",
    ".gitignore",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".md",
    ".py",
    ".sh",
    ".swift",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}

LOCAL_PATH_PATTERNS = (
    re.compile(r"/" + r"Users/[^/\s]+/"),
    re.compile(r"/" + r"home/[^/\s]+/"),
    re.compile(r"[A-Za-z]:\\" + r"Users\\[^\\\s]+\\", re.IGNORECASE),
)
TOKEN_PATTERNS = (
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
)
SECRET_ASSIGNMENT = re.compile(
    r"(?im)^\s*(?:export\s+)?"
    r"[A-Z0-9_]*(?:API_KEY|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)[A-Z0-9_]*"
    r"\s*[:=]\s*[\"']?([^\s#\"']+)"
)
SAFE_PLACEHOLDER_VALUES = {
    "changeme",
    "example",
    "false",
    "none",
    "null",
    "placeholder",
    "true",
}
SAFE_CODE_VALUE_PREFIXES = (
    "(",
    "[",
    "{",
    "dict(",
    "getenv(",
    "os.environ",
    "path(",
    "re.",
)


@dataclass(frozen=True)
class Finding:
    kind: str
    path: Path
    detail: str

    def format(self, root: Path) -> str:
        try:
            display_path = self.path.relative_to(root)
        except ValueError:
            display_path = self.path
        return f"{self.kind}: {display_path}: {self.detail}"


def is_sensitive_filename(path: Path) -> bool:
    name = path.name.lower()
    if name == ".env.example":
        return False
    if name.startswith(".env."):
        return True
    return name in SENSITIVE_EXACT_NAMES or path.suffix.lower() in SENSITIVE_SUFFIXES


def looks_textual(path: Path) -> bool:
    if path.name in {"Dockerfile", "Containerfile"}:
        return True
    return path.suffix.lower() in TEXT_SUFFIXES


def read_text_safely(path: Path) -> str | None:
    if not looks_textual(path):
        return None
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:
        return None
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def secret_assignment_value(text: str) -> str | None:
    for match in SECRET_ASSIGNMENT.finditer(text):
        value = match.group(1).strip()
        normalized = value.lower()
        if (
            not value
            or normalized in SAFE_PLACEHOLDER_VALUES
            or normalized.startswith(SAFE_CODE_VALUE_PREFIXES)
            or value.startswith("$")
            or value.startswith("<")
            or value.startswith("{{")
        ):
            continue
        return value[:8] + "…" if len(value) > 8 else "已设置非占位值"
    return None


def scan_public_bundle(root: Path) -> list[Finding]:
    root = root.resolve()
    findings: list[Finding] = []
    for path in sorted(root.rglob("*")):
        if any(part in SKIP_DIRECTORIES for part in path.parts):
            continue
        if path.is_symlink():
            try:
                path.resolve(strict=True).relative_to(root)
            except (FileNotFoundError, ValueError):
                findings.append(
                    Finding("external_symlink", path, "符号链接指向公共仓库之外")
                )
            continue
        if not path.is_file():
            continue
        if path.name.lower() in PRIVATE_CSV_NAMES:
            findings.append(
                Finding("private_runtime_csv", path, "私人或运行时增量 CSV 不得发布")
            )
        if is_sensitive_filename(path):
            findings.append(
                Finding("sensitive_filename", path, "疑似凭证、私钥或环境配置文件")
            )

        # This checker necessarily contains the token and key signatures it
        # searches for. Keep filename checks active, but do not scan its own
        # source text and report those detector definitions as credentials.
        if path.resolve() == SELF_PATH:
            continue
        text = read_text_safely(path)
        if text is None:
            continue
        for pattern in LOCAL_PATH_PATTERNS:
            if pattern.search(text):
                findings.append(
                    Finding("local_absolute_path", path, "包含本机用户目录绝对路径")
                )
                break
        private_key_marker = "BEGIN " + "PRIVATE KEY"
        rsa_key_marker = "BEGIN RSA " + "PRIVATE KEY"
        if private_key_marker in text or rsa_key_marker in text:
            findings.append(
                Finding("private_key", path, "包含私钥正文")
            )
        if any(pattern.search(text) for pattern in TOKEN_PATTERNS):
            findings.append(
                Finding("access_token", path, "包含疑似访问令牌")
            )
        assignment = secret_assignment_value(text)
        if assignment is not None:
            findings.append(
                Finding("embedded_secret", path, f"敏感变量包含非占位值：{assignment}")
            )
    return findings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=LAB_ROOT,
        help="待检查的公共仓库或构建包根目录（默认项目根）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    findings = scan_public_bundle(root)
    if findings:
        print(f"公共发布包审计失败：发现 {len(findings)} 项。", file=sys.stderr)
        for finding in findings:
            print(f"- {finding.format(root)}", file=sys.stderr)
        return 1
    print(f"公共发布包审计通过：{root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
