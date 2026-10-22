/**
 * 通用工具函数集合
 * 提供日期格式化、号码格式化、颜色生成等辅助功能
 */

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {string|Date} date 日期对象或字符串
 * @returns {string} 格式化后的日期
 */
export function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toISOString().split('T')[0]
}

/**
 * 将号码数组格式化为空格分隔的字符串
 * @param {number[]} numbers 号码数组
 * @returns {string} 空格分隔的字符串
 */
export function formatNumbers(numbers) {
  return numbers.join(' ')
}

/**
 * 获取随机颜色（用于标签或高亮）
 * @returns {string} 颜色值
 */
export function getRandomColor() {
  const colors = ['#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399', '#9B59B6']
  return colors[Math.floor(Math.random() * colors.length)]
}