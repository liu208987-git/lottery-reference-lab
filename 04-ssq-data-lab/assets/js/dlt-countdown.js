// 大乐透开奖倒计时
//
// 开奖规则（来源：中国体育彩票管理中心公开规则）：
//   - 周一、周三、周六 20:30 开奖
//   - 单期销售于开奖日 20:00 截止
// 时区：以中国标准时间（UTC+8）为基准。

const DLT_DRAW_DAYS = [1, 3, 6]; // 1=周一, 3=周三, 6=周六
const DLT_DRAW_HOUR = 20;
const DLT_DRAW_MINUTE = 30;
const DLT_SALE_CUTOFF_HOUR = 20;
const DLT_SALE_CUTOFF_MINUTE = 0;
const CN_OFFSET_MINUTES = 8 * 60;

export function toChinaParts(date) {
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

function chinaTimeToDate(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

/** 找下次大乐透开奖时刻。 */
export function nextDltDrawTime(now = new Date()) {
  for (let offset = 0; offset < 8; offset++) {
    const probe = new Date(now.getTime() + offset * 86_400_000);
    const p = toChinaParts(probe);
    if (!DLT_DRAW_DAYS.includes(p.weekday)) continue;
    const draw = chinaTimeToDate(p.year, p.month, p.day, DLT_DRAW_HOUR, DLT_DRAW_MINUTE);
    if (draw.getTime() > now.getTime()) return draw;
  }
  return null;
}

export function dltSaleCutoffOf(drawDate) {
  const p = toChinaParts(drawDate);
  return chinaTimeToDate(p.year, p.month, p.day, DLT_SALE_CUTOFF_HOUR, DLT_SALE_CUTOFF_MINUTE);
}

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

export function formatChinaTime(date) {
  const p = toChinaParts(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} 周${WEEKDAY_CN[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * 大乐透期号是 5 位（如 26054），跨年时下一期变成 1。
 * 如果上期是 25154 → 跨年 → 26001；同年则 +1。
 */
export function nextDltIssueOf(latestIssue, drawDate) {
  if (!latestIssue || !/^\d{5}$/.test(String(latestIssue))) return null;
  const issue = String(latestIssue);
  const lastYY = Number(issue.slice(0, 2));
  const lastSeq = Number(issue.slice(2));
  const cnYear = toChinaParts(drawDate).year;
  const drawYY = cnYear % 100;
  if (drawYY === lastYY) return `${String(lastYY).padStart(2, "0")}${String(lastSeq + 1).padStart(3, "0")}`;
  return `${String(drawYY).padStart(2, "0")}001`;
}
