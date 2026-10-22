/**
 * 预测 API
 * 提供生成预测结果的功能
 */
import request from '@/utils/request'

/**
 * 生成预测
 * @param {Object} data - 预测参数
 * @param {string} data.lottery_type - 'ssq' 或 'dlt'
 * @returns {Promise} 返回预测结果 { red, blue, quality_score, model_version }
 */
export function getPrediction(data) {
  return request({
    url: '/predict/',
    method: 'post',
    data
  })
}