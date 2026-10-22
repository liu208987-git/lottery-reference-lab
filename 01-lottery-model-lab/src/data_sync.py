from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from lottery_lab import Draw, GAME_SPECS, suggest_next_draw, validate_draw


API_URL = "https://jc.zhcw.com/port/client_json.php"
CALLBACK = "lottery_lab_sync"
PAGE_SIZE = 1000
START_DATE = date(1900, 1, 1)
LOOKBACK_DAYS = 45
CHINA_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")

TIME_SOURCE_URLS = (
    "https://www.zhcw.com/",
    "https://www.cwl.gov.cn/",
    "https://www.lottery.gov.cn/",
)

LOTTERY_IDS = {"ssq": "1", "dlt": "281"}
SOURCE_PAGES = {
    "ssq": "https://www.zhcw.com/kjxx/ssq/",
    "dlt": "https://www.zhcw.com/kjxx/dlt/",
}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)


class DataSyncError(RuntimeError):
    """Raised when a remote response cannot be trusted or normalized."""


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes = b""


HttpTransport = Callable[[Request, float], HttpResponse]


@dataclass(frozen=True)
class TrustedTime:
    now_utc: datetime
    source: str
    network_sources: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.now_utc.tzinfo is None:
            raise ValueError("可信时间必须包含时区")

    @property
    def current_date(self) -> date:
        return self.now_utc.astimezone(CHINA_TIMEZONE).date()

    @property
    def uses_network_time(self) -> bool:
        return self.source == "network_date_header"

    def as_dict(self) -> dict[str, object]:
        return {
            "now_utc": self.now_utc.astimezone(timezone.utc).isoformat(),
            "current_date": self.current_date.isoformat(),
            "source": self.source,
            "uses_network_time": self.uses_network_time,
            "network_sources": list(self.network_sources),
            "errors": list(self.errors),
        }


@dataclass(frozen=True)
class GameSyncResult:
    lottery_code: str
    query_start_date: date
    query_end_date: date
    existing_count: int
    fetched_count: int
    source_duplicate_count: int
    already_present_count: int
    ignored_future_count: int
    candidates: tuple[Draw, ...] = ()
    error: str | None = None

    @property
    def status(self) -> str:
        if self.error:
            return "error"
        if self.candidates:
            return "updates_available"
        return "up_to_date"

    def as_dict(self) -> dict[str, object]:
        return {
            "lottery_code": self.lottery_code,
            "status": self.status,
            "query_start_date": self.query_start_date.isoformat(),
            "query_end_date": self.query_end_date.isoformat(),
            "existing_count": self.existing_count,
            "fetched_count": self.fetched_count,
            "source_duplicate_count": self.source_duplicate_count,
            "already_present_count": self.already_present_count,
            "ignored_future_count": self.ignored_future_count,
            "candidate_count": len(self.candidates),
            "candidates": [draw_to_dict(draw) for draw in self.candidates],
            "error": self.error,
        }


@dataclass(frozen=True)
class SyncScan:
    trusted_time: TrustedTime
    games: Mapping[str, GameSyncResult]

    @property
    def candidate_count(self) -> int:
        return sum(len(result.candidates) for result in self.games.values())

    def as_dict(self) -> dict[str, object]:
        return {
            "trusted_time": self.trusted_time.as_dict(),
            "candidate_count": self.candidate_count,
            "games": {
                code: result.as_dict() for code, result in self.games.items()
            },
        }


def draw_to_dict(draw: Draw) -> dict[str, object]:
    return {
        "issue": draw.issue,
        "draw_date": draw.draw_date.isoformat(),
        "front": list(draw.front),
        "back": list(draw.back),
    }


def default_http_transport(request: Request, timeout: float) -> HttpResponse:
    with urlopen(request, timeout=timeout) as response:
        return HttpResponse(
            status=int(response.status),
            headers=dict(response.headers.items()),
            body=response.read(),
        )


def _system_utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        value = value.astimezone()
    return value.astimezone(timezone.utc)


def _header_value(headers: Mapping[str, str], name: str) -> str | None:
    lowered_name = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered_name:
            return value
    return None


def _parse_http_date(headers: Mapping[str, str]) -> datetime:
    raw_value = _header_value(headers, "Date")
    if not raw_value:
        raise DataSyncError("响应缺少 Date header")
    try:
        parsed = parsedate_to_datetime(raw_value)
    except (TypeError, ValueError) as error:
        raise DataSyncError(f"响应 Date header 无效: {raw_value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def get_trusted_utc_now(
    *,
    transport: HttpTransport = default_http_transport,
    source_urls: Sequence[str] = TIME_SOURCE_URLS,
    local_now: Callable[[], datetime] = _system_utc_now,
    timeout: float = 5.0,
) -> TrustedTime:
    """Read HTTPS response Date headers and return their median UTC time.

    A single successful HTTPS source is still preferable to an unchecked local
    clock. If every source fails, the local clock is returned with an explicit
    ``local_clock_fallback`` marker and the individual failures attached.
    """

    samples: list[tuple[str, datetime]] = []
    errors: list[str] = []
    for url in source_urls:
        request = Request(
            url,
            headers={"Accept": "*/*", "User-Agent": USER_AGENT},
            method="HEAD",
        )
        try:
            response = transport(request, timeout)
            if not 200 <= response.status < 400:
                raise DataSyncError(f"HTTP {response.status}")
            samples.append((url, _parse_http_date(response.headers)))
        except Exception as error:  # every source is allowed to fail independently
            errors.append(f"{url}: {error}")

    if samples:
        ordered_timestamps = sorted(item.timestamp() for _, item in samples)
        middle = len(ordered_timestamps) // 2
        if len(ordered_timestamps) % 2:
            median_timestamp = ordered_timestamps[middle]
        else:
            median_timestamp = (
                ordered_timestamps[middle - 1] + ordered_timestamps[middle]
            ) / 2.0
        return TrustedTime(
            now_utc=datetime.fromtimestamp(median_timestamp, tz=timezone.utc),
            source="network_date_header",
            network_sources=tuple(url for url, _ in samples),
            errors=tuple(errors),
        )

    return TrustedTime(
        now_utc=_as_utc(local_now()),
        source="local_clock_fallback",
        errors=tuple(errors),
    )


def _parse_jsonp(body: bytes) -> dict[str, Any]:
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise DataSyncError("接口响应不是 UTF-8") from error
    match = re.fullmatch(r"\s*[^()]+\((.*)\)\s*;?\s*", text, flags=re.DOTALL)
    if not match:
        raise DataSyncError("接口没有返回预期的 JSONP 数据")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise DataSyncError("接口 JSONP 内容无法解析") from error
    if not isinstance(payload, dict):
        raise DataSyncError("接口 JSONP 内容不是对象")
    if payload.get("resCode") != "000000":
        raise DataSyncError(
            f"接口返回错误: {payload.get('resCode')} {payload.get('message', '')}".strip()
        )
    return payload


def _api_request(
    lottery_code: str,
    page_number: int,
    start_date: date,
    end_date: date,
    request_time: datetime,
    *,
    api_url: str,
) -> Request:
    params = {
        "transactionType": "10001001",
        "lotteryId": LOTTERY_IDS[lottery_code],
        "issueCount": "0",
        "startIssue": "",
        "endIssue": "",
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "type": "2",
        "pageNum": str(page_number),
        "pageSize": str(PAGE_SIZE),
        "callback": CALLBACK,
        "tt": f"{int(request_time.timestamp() * 1000)}{page_number:04d}",
    }
    return Request(
        f"{api_url}?{urlencode(params)}",
        headers={
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": SOURCE_PAGES[lottery_code],
            "User-Agent": USER_AGENT,
        },
    )


def _fetch_page(
    request: Request,
    *,
    transport: HttpTransport,
    timeout: float,
    attempts: int,
) -> dict[str, Any]:
    if attempts < 1:
        raise ValueError("attempts 必须至少为 1")
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            response = transport(request, timeout)
            if response.status != 200:
                raise DataSyncError(f"接口返回 HTTP {response.status}")
            return _parse_jsonp(response.body)
        except Exception as error:
            last_error = error
    raise DataSyncError(f"接口请求失败，已尝试 {attempts} 次: {last_error}") from last_error


def _fetch_api_records(
    lottery_code: str,
    start_date: date,
    end_date: date,
    request_time: datetime,
    *,
    transport: HttpTransport,
    timeout: float,
    attempts: int,
    api_url: str,
) -> tuple[list[dict[str, Any]], int]:
    first = _fetch_page(
        _api_request(
            lottery_code,
            1,
            start_date,
            end_date,
            request_time,
            api_url=api_url,
        ),
        transport=transport,
        timeout=timeout,
        attempts=attempts,
    )
    try:
        expected_total = int(first.get("total", 0))
        total_pages = int(first.get("pages", 0))
        first_data = first.get("data", [])
    except (TypeError, ValueError) as error:
        raise DataSyncError("接口分页元数据无效") from error
    if expected_total < 0 or total_pages < 0 or not isinstance(first_data, list):
        raise DataSyncError("接口分页元数据无效")
    records = list(first_data)

    for page_number in range(2, total_pages + 1):
        page = _fetch_page(
            _api_request(
                lottery_code,
                page_number,
                start_date,
                end_date,
                request_time,
                api_url=api_url,
            ),
            transport=transport,
            timeout=timeout,
            attempts=attempts,
        )
        try:
            page_total = int(page.get("total", 0))
            page_data = page.get("data", [])
        except (TypeError, ValueError) as error:
            raise DataSyncError("接口分页元数据无效") from error
        if page_total != expected_total:
            raise DataSyncError("接口分页期间总记录数发生变化")
        if not isinstance(page_data, list):
            raise DataSyncError("接口分页 data 不是列表")
        records.extend(page_data)

    if len(records) != expected_total:
        raise DataSyncError(
            f"接口记录数不完整: 声明 {expected_total}，实际 {len(records)}"
        )
    return records, expected_total


def _split_numbers(value: Any) -> tuple[int, ...]:
    if isinstance(value, (list, tuple)):
        raw_values = value
    else:
        raw_values = re.findall(r"\d+", str(value or ""))
    try:
        return tuple(int(number) for number in raw_values)
    except (TypeError, ValueError) as error:
        raise DataSyncError(f"开奖号码无法解析: {value!r}") from error


def _normalize_api_draws(
    lottery_code: str,
    records: Sequence[Mapping[str, Any]],
) -> tuple[list[Draw], int]:
    spec = GAME_SPECS[lottery_code]
    by_issue: dict[str, Draw] = {}
    duplicate_count = 0
    for raw in records:
        issue = str(raw.get("issue", "")).strip()
        raw_date = str(raw.get("openTime", "")).strip()
        if not issue or not issue.isdigit():
            raise DataSyncError(f"{spec.name}接口存在无效期号: {issue!r}")
        try:
            draw_date = date.fromisoformat(raw_date[:10])
        except ValueError as error:
            raise DataSyncError(
                f"{spec.name} {issue} 开奖日期无效: {raw_date!r}"
            ) from error
        draw = Draw(
            issue=issue,
            draw_date=draw_date,
            front=_split_numbers(raw.get("frontWinningNum")),
            back=_split_numbers(raw.get("backWinningNum")),
        )
        try:
            validate_draw(draw, spec)
        except ValueError as error:
            raise DataSyncError(str(error)) from error
        previous = by_issue.get(issue)
        if previous is not None:
            if previous != draw:
                raise DataSyncError(f"{spec.name}同一期号存在冲突接口数据: {issue}")
            duplicate_count += 1
            continue
        by_issue[issue] = draw

    return sorted(by_issue.values(), key=lambda draw: int(draw.issue)), duplicate_count


def fetch_missing_draws(
    lottery_code: str,
    existing_draws: Sequence[Draw],
    trusted_time: TrustedTime,
    *,
    transport: HttpTransport = default_http_transport,
    timeout: float = 20.0,
    attempts: int = 3,
    api_url: str = API_URL,
) -> GameSyncResult:
    """Fetch and return validated remote draws absent from local history.

    The local sequence is never mutated. The query starts at the latest local
    draw date (inclusive, so the boundary record can be cross-checked), and
    candidates later than the trusted China-local date are always discarded.
    """

    if lottery_code not in GAME_SPECS:
        raise ValueError("lottery_code 必须是 ssq 或 dlt")
    spec = GAME_SPECS[lottery_code]
    existing_by_issue: dict[str, Draw] = {}
    for draw in existing_draws:
        try:
            validate_draw(draw, spec)
        except ValueError as error:
            raise DataSyncError(str(error)) from error
        previous = existing_by_issue.get(draw.issue)
        if previous is not None and previous != draw:
            raise DataSyncError(f"{spec.name}本地同一期号存在冲突数据: {draw.issue}")
        existing_by_issue[draw.issue] = draw

    latest_existing = (
        max(
            existing_by_issue.values(),
            key=lambda draw: (draw.draw_date, int(draw.issue)),
        )
        if existing_by_issue
        else None
    )
    query_start_date = (
        max(START_DATE, latest_existing.draw_date - timedelta(days=LOOKBACK_DAYS))
        if latest_existing
        else START_DATE
    )
    query_end_date = trusted_time.current_date
    if query_start_date > query_end_date:
        raise DataSyncError(
            f"{spec.name}本地最新开奖日 {query_start_date} 晚于可信当前日期 {query_end_date}"
        )

    raw_records, _ = _fetch_api_records(
        lottery_code,
        query_start_date,
        query_end_date,
        trusted_time.now_utc,
        transport=transport,
        timeout=timeout,
        attempts=attempts,
        api_url=api_url,
    )
    remote_draws, source_duplicate_count = _normalize_api_draws(
        lottery_code, raw_records
    )
    missing_draws: list[Draw] = []
    already_present_count = 0
    ignored_future_count = 0
    for draw in remote_draws:
        if draw.draw_date > query_end_date:
            ignored_future_count += 1
            continue
        existing = existing_by_issue.get(draw.issue)
        if existing is not None:
            if existing != draw:
                raise DataSyncError(
                    f"{spec.name}接口与本地数据冲突: {draw.issue}"
                )
            already_present_count += 1
            continue
        missing_draws.append(draw)

    missing_draws.sort(key=lambda draw: (draw.draw_date, int(draw.issue)))
    if latest_existing is not None:
        recent_gaps = [
            draw
            for draw in missing_draws
            if draw.draw_date <= latest_existing.draw_date
        ]
        if recent_gaps:
            issues = ", ".join(draw.issue for draw in recent_gaps[:5])
            raise DataSyncError(
                f"{spec.name}本地最近 {LOOKBACK_DAYS} 天历史存在缺口: {issues}"
            )

        current_draws = sorted(
            existing_by_issue.values(),
            key=lambda draw: (draw.draw_date, int(draw.issue)),
        )
        for draw in missing_draws:
            expected_issue, _ = suggest_next_draw(current_draws, spec)
            if draw.issue != expected_issue:
                raise DataSyncError(
                    f"{spec.name}接口缺少连续期号 {expected_issue}，"
                    f"不能越过并写入 {draw.issue}"
                )
            current_draws.append(draw)

    candidates = tuple(missing_draws)
    return GameSyncResult(
        lottery_code=lottery_code,
        query_start_date=query_start_date,
        query_end_date=query_end_date,
        existing_count=len(existing_by_issue),
        fetched_count=len(remote_draws),
        source_duplicate_count=source_duplicate_count,
        already_present_count=already_present_count,
        ignored_future_count=ignored_future_count,
        candidates=candidates,
    )


def scan_missing_draws(
    existing_by_code: Mapping[str, Sequence[Draw]],
    *,
    transport: HttpTransport = default_http_transport,
    time_source_urls: Sequence[str] = TIME_SOURCE_URLS,
    local_now: Callable[[], datetime] = _system_utc_now,
    time_timeout: float = 5.0,
    api_timeout: float = 20.0,
    api_attempts: int = 3,
    api_url: str = API_URL,
) -> SyncScan:
    """Scan both games independently so one failed API does not hide the other."""

    trusted_time = get_trusted_utc_now(
        transport=transport,
        source_urls=time_source_urls,
        local_now=local_now,
        timeout=time_timeout,
    )
    games: dict[str, GameSyncResult] = {}
    for lottery_code in GAME_SPECS:
        existing_draws = existing_by_code.get(lottery_code, ())
        latest_date = max(
            (draw.draw_date for draw in existing_draws),
            default=None,
        )
        query_start_date = (
            max(START_DATE, latest_date - timedelta(days=LOOKBACK_DAYS))
            if latest_date
            else START_DATE
        )
        try:
            games[lottery_code] = fetch_missing_draws(
                lottery_code,
                existing_draws,
                trusted_time,
                transport=transport,
                timeout=api_timeout,
                attempts=api_attempts,
                api_url=api_url,
            )
        except Exception as error:
            games[lottery_code] = GameSyncResult(
                lottery_code=lottery_code,
                query_start_date=query_start_date,
                query_end_date=trusted_time.current_date,
                existing_count=len(existing_draws),
                fetched_count=0,
                source_duplicate_count=0,
                already_present_count=0,
                ignored_future_count=0,
                error=str(error),
            )
    return SyncScan(trusted_time=trusted_time, games=games)
