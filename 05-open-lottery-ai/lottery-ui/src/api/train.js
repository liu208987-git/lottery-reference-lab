/**
 * 模型训练 API
 * 提供训练任务提交和状态查询
 */
import request from '@/utils/request'

/**
 * 提交训练任务
 * @param {Object} data - 训练参数
 * @param {string} data.lottery_type - 'ssq' 或 'dlt'
 * @param {number} data.epochs - 训练轮数
 * @param {number} data.batch_size - 批次大小
 * @param {number} data.seq_len - 序列长度
 * @param {number} data.learning_rate - 学习率
 * @returns {Promise} 返回 { task_id, status, message }
 */
export function startTraining(data) {
  return request({
    url: '/train/start',
    method: 'post',
    data
  })
}

/**
 * 查询训练任务状态
 * @param {string} taskId - 任务 ID
 * @returns {Promise} 返回 { status, result }
 */
export function getTrainStatus(taskId) {
  return request({
    url: `/train/status/${taskId}`,
    method: 'get'
  })
}