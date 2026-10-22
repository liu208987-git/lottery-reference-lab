/**
 * 数据查询 API
 * 包含双色球（ssq）和大乐透（dlt）的历史数据接口
 */
import request from '@/utils/request'

/**
 * 获取双色球历史数据（分页）
 * @param {Object} params - 查询参数
 * @param {number} params.limit - 每页条数
 * @param {number} params.offset - 偏移量
 * @returns {Promise} 返回分页数据 { items, total }
 */
export function listSSQData(params) {
  return request({
    url: '/data/ssq',
    method: 'get',
    params
  })
}

/**
 * 获取最新一期双色球
 * @returns {Promise} 返回最新一条记录
 */
export function getLatestSSQ() {
  return request({
    url: '/data/ssq/latest',
    method: 'get'
  })
}

/**
 * 获取大乐透历史数据（分页）
 * @param {Object} params - 查询参数
 * @param {number} params.limit - 每页条数
 * @param {number} params.offset - 偏移量
 * @returns {Promise} 返回分页数据
 */
export function listDLTData(params) {
  return request({
    url: '/data/dlt',
    method: 'get',
    params
  })
}

/**
 * 获取最新一期大乐透
 * @returns {Promise} 返回最新一条记录
 */
export function getLatestDLT() {
  return request({
    url: '/data/dlt/latest',
    method: 'get'
  })
}