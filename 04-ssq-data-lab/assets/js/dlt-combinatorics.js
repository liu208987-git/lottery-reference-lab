// 大乐透胆拖 / 复式 / 注数试算
//
// 大乐透前区 5 选 35，后区 2 选 12。胆拖：
//   前区 dan_F 个胆 + tuo_F 个拖（≥ 5 - dan_F），后区 dan_B 个胆 + tuo_B 个拖（≥ 2 - dan_B）
//   注数 = C(tuo_F, 5 - dan_F) × C(tuo_B, 2 - dan_B)

import { combinations as choose } from "./combinatorics.js";

/** 大乐透单注价格 = 2 元（基本投注）。 */
export const DLT_PRICE_PER_TICKET = 2;

export function dltPriceOf(tickets) {
  return tickets * DLT_PRICE_PER_TICKET;
}

/**
 * 大乐透胆拖注数。
 * @param danFront 前区胆码数（0-4）
 * @param tuoFront 前区拖码数（≥ 5-danFront）
 * @param danBack  后区胆码数（0-1）
 * @param tuoBack  后区拖码数（≥ 2-danBack）
 */
export function dltDanTuoTickets({ danFront = 0, tuoFront = 5, danBack = 0, tuoBack = 2 }) {
  if (danFront < 0 || danFront > 4) throw new Error("前区胆码 0-4");
  if (tuoFront < 5 - danFront) throw new Error(`前区拖码至少 ${5 - danFront} 个`);
  if (danFront + tuoFront > 35) throw new Error("前区总数不能超过 35");
  if (danBack < 0 || danBack > 1) throw new Error("后区胆码 0-1");
  if (tuoBack < 2 - danBack) throw new Error(`后区拖码至少 ${2 - danBack} 个`);
  if (danBack + tuoBack > 12) throw new Error("后区总数不能超过 12");
  const front = choose(tuoFront, 5 - danFront);
  const back = choose(tuoBack, 2 - danBack);
  return front * back;
}

/** 大乐透复式注数。 */
export function dltComplexTickets(frontCount, backCount) {
  if (frontCount < 5 || frontCount > 35) throw new Error("前区 5-35 个");
  if (backCount < 2 || backCount > 12) throw new Error("后区 2-12 个");
  return choose(frontCount, 5) * choose(backCount, 2);
}

export { choose as combinations };
