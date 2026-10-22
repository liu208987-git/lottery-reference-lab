// 双色球开奖倒计时
//
// 开奖规则（来源：中国福利彩票发行管理中心公开规则）：
//   - 周二、周四、周日 21:15 开奖
//   - 单期销售于开奖日 20:00 截止
//
// 时区：以中国标准时间（UTC+8）为基准，避免用户本地时区误差。

const DRAW_DAYS = [0, 2, 4]; // 0=周日, 2=周二, 4=周四
const DRAW_HOUR = 21;
const DRAW_MINUTE = 15;
const SALE_CUTOFF_HOUR = 20;
const SALE_CUTOFF_MINUTE = 0;
const CN_OFFSET_MINUTES = 8 * 60;

/** 把任意 Date 转成「中国时区视角」的 {year, month, day, hour, minute, weekday}。 */
export function toChinaParts(date) {
  // Date.getTime() 已经是 UTC 毫秒，加 8h 后用 getUTC* 系列即可读出"中国时间"的字段。
  const cn = new Date(date.getTime() + CN_OFFSET_MINUTES * 60_000);
  return {
    year: cn.getUTCFullYear(),
    month: cn.getUTCMonth() + 1,
    day: cn.getUTCDate(),
    hour: cn.getUTCHours(),
    minute: cn.getUTCMinutes(),
    second: cn.getUTCSeconds(),
    weekday: cn.getUTCDay(),
    raw: cn,
  };
}

/** 给定中国时区的 (year, month, day, hour, minute)，返回对应 UTC 的 Date。 */
function chinaTimeToDate(year, month, day, hour, minute) {
  // Date.UTC 把传入参数视为 UTC；中国时间 t 对应 UTC = t - 8h。
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

/** 从「中国时区视角」的 now 开始，找下一个开奖时刻。 */
export function nextDrawTime(now = new Date()) {
  const cn = toChinaParts(now);
  for (let offset = 0; offset < 8; offset++) {
    const probe = new Date(now.getTime() + offset * 86_400_000);
    const p = toChinaParts(probe);
    if (!DRAW_DAYS.includes(p.weekday)) continue;
    const draw = chinaTimeToDate(p.year, p.month, p.day, DRAW_HOUR, DRAW_MINUTE);
    if (draw.getTime() > now.getTime()) return draw;
  }
  // 理论上不会到这里
  return null;
}

/** 同期销售截止时间（开奖日 20:00）。 */
export function saleCutoffOf(drawDate) {
  const p = toChinaParts(drawDate);
  return chinaTimeToDate(p.year, p.month, p.day, SALE_CUTOFF_HOUR, SALE_CUTOFF_MINUTE);
}

/** 把「下次开奖时间 - now」拆成 d/h/m/s。 */
export function diffDuration(target, now = new Date()) {
  const ms = Math.max(0, target.getTime() - now.getTime());
  const totalSec = Math.floor(ms / 1000);
  return {
    totalMs: ms,
    days: Math.floor(totalSec / 86400),
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
  };
}

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 给一个 Date 返回「2026-05-22（周五）21:15」格式。 */
export function formatChinaTime(date) {
  const p = toChinaParts(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} 周${WEEKDAY_CN[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * 给定上一期的 issue（如 "2026054"），推出下一期的 issue（"2026055"）。
 * 跨年通过下一期开奖日的中国年份判断。
 */
export function nextIssueOf(latestIssue, drawDate) {
  if (!latestIssue || !/^\d{7}$/.test(String(latestIssue))) return null;
  const issue = String(latestIssue);
  const lastYear = Number(issue.slice(0, 4));
  const lastSeq = Number(issue.slice(4));
  const cnYear = toChinaParts(drawDate).year;
  if (cnYear === lastYear) return `${cnYear}${String(lastSeq + 1).padStart(3, "0")}`;
  return `${cnYear}001`;
}
