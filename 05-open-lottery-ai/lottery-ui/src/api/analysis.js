import request from '@/utils/request'

/**
 * 获取今日预测分析
 * @param {string} lotteryType - 'ssq' 或 'dlt'
 */
export function getTodayAnalysis(lotteryType = 'ssq') {
  return request({
    url: '/analysis/today',
    method: 'get',
    params: { lottery_type: lotteryType }
  })
}