import request from '@/utils/request'

/**
 * 获取已训练模型列表
 * @returns {Promise} 返回 { models: [...] }
 */
export function listModels() {
  return request({
    url: '/models/list',
    method: 'get'
  })
}

/**
 * 下载模型文件
 * @param {string} modelName - 模型文件名
 * @returns {Promise<Blob>}
 */
export function downloadModel(modelName) {
  return request({
    url: `/models/download/${modelName}`,
    method: 'get',
    responseType: 'blob'
  })
}