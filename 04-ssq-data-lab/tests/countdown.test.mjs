import { test } from "node:test";
import assert from "node:assert/strict";

import {
  toChinaParts,
  nextDrawTime,
  saleCutoffOf,
  diffDuration,
  formatChinaTime,
  nextIssueOf,
} from "../assets/js/countdown.js";

// 工具：构造"中国时间 t" 的 Date 对象（UTC = 中国 - 8h）
function cn(year, month, day, hour, minute, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

test("toChinaParts converts to UTC+8 view", () => {
  // 2026-05-22 14:00 UTC = 22:00 China
  const d = new Date(Date.UTC(2026, 4, 22, 14, 0, 0));
  const p = toChinaParts(d);
  assert.equal(p.year, 2026);
  assert.equal(p.month, 5);
  assert.equal(p.day, 22);
  assert.equal(p.hour, 22);
  assert.equal(p.minute, 0);
  assert.equal(p.weekday, 5); // Friday
});

test("nextDrawTime: thursday 21:14 china -> same day 21:15", () => {
  const now = cn(2026, 5, 21, 21, 14, 0); // 周四 21:14
  const next = nextDrawTime(now);
  const p = toChinaParts(next);
  assert.equal(p.weekday, 4);
  assert.equal(p.hour, 21);
  assert.equal(p.minute, 15);
  assert.equal(p.day, 21);
});

test("nextDrawTime: thursday 21:16 china -> next sunday", () => {
  const now = cn(2026, 5, 21, 21, 16, 0); // 周四 21:16，已过开奖
  const next = nextDrawTime(now);
  const p = toChinaParts(next);
  assert.equal(p.weekday, 0); // Sunday
});

test("nextDrawTime: friday -> next sunday", () => {
  const now = cn(2026, 5, 22, 10, 0, 0); // 周五
  const next = nextDrawTime(now);
  const p = toChinaParts(next);
  assert.equal(p.weekday, 0);
  assert.equal(p.hour, 21);
  assert.equal(p.minute, 15);
});

test("nextDrawTime: monday -> tuesday", () => {
  const now = cn(2026, 5, 18, 10, 0, 0); // 周一
  const next = nextDrawTime(now);
  const p = toChinaParts(next);
  assert.equal(p.weekday, 2); // Tuesday
});

test("nextDrawTime: sunday before 21:15 -> same day", () => {
  const now = cn(2026, 5, 24, 12, 0, 0); // 周日 12:00
  const next = nextDrawTime(now);
  const p = toChinaParts(next);
  assert.equal(p.weekday, 0);
  assert.equal(p.day, 24);
});

test("saleCutoffOf returns 20:00 of draw day", () => {
  const draw = cn(2026, 5, 22, 21, 15);
  const cutoff = saleCutoffOf(draw);
  const p = toChinaParts(cutoff);
  assert.equal(p.hour, 20);
  assert.equal(p.minute, 0);
  assert.equal(p.day, 22);
});

test("diffDuration handles d/h/m/s", () => {
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const target = new Date(Date.UTC(2026, 0, 2, 1, 2, 3));
  const d = diffDuration(target, now);
  assert.equal(d.days, 1);
  assert.equal(d.hours, 1);
  assert.equal(d.minutes, 2);
  assert.equal(d.seconds, 3);
});

test("diffDuration clamps negative to zero", () => {
  const now = new Date(Date.UTC(2026, 0, 2));
  const target = new Date(Date.UTC(2026, 0, 1));
  const d = diffDuration(target, now);
  assert.equal(d.totalMs, 0);
});

test("formatChinaTime renders weekday in Chinese", () => {
  const t = cn(2026, 5, 22, 21, 15);
  assert.equal(formatChinaTime(t), "2026-05-22 周五 21:15");
});

test("nextIssueOf: same year increments seq", () => {
  const draw = cn(2026, 5, 22, 21, 15);
  assert.equal(nextIssueOf("2026054", draw), "2026055");
});

test("nextIssueOf: cross year resets seq to 001", () => {
  const draw = cn(2027, 1, 5, 21, 15);
  assert.equal(nextIssueOf("2026152", draw), "2027001");
});

test("nextIssueOf: invalid input returns null", () => {
  const draw = cn(2026, 5, 22, 21, 15);
  assert.equal(nextIssueOf("bad", draw), null);
  assert.equal(nextIssueOf("", draw), null);
  assert.equal(nextIssueOf(null, draw), null);
});
