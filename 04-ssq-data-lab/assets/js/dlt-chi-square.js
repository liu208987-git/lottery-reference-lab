// 大乐透卡方拟合优度检验
//
// 前区 5 选 35：每期贡献 5 次出现，df = 34
// 后区 2 选 12：每期贡献 2 次出现，df = 11

import { chiSquared, expectedUniform, chiSquaredPValue } from "./chi-square.js";

export function frontChi(draws) {
  const observed = Array(35).fill(0);
  for (const d of draws) for (const r of d.front) observed[r - 1]++;
  const total = draws.length * 5;
  const expected = expectedUniform(total, 35);
  return { chi: chiSquared(observed, expected), df: 34, observed, expected };
}

export function backChi(draws) {
  const observed = Array(12).fill(0);
  for (const d of draws) for (const r of d.back) observed[r - 1]++;
  const total = draws.length * 2;
  const expected = expectedUniform(total, 12);
  return { chi: chiSquared(observed, expected), df: 11, observed, expected };
}

export { chiSquaredPValue };
