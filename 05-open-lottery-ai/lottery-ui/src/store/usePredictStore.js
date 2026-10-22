/**
 * 预测状态管理（Pinia Store）
 * 管理预测结果和错误信息
 */
import { defineStore } from 'pinia'
import { getPrediction } from '@/api/predict'

export const usePredictStore = defineStore('predict', {
  state: () => ({
    result: null,       // 预测结果
    loading: false,     // 加载状态
    error: null         // 错误信息
  }),
  actions: {
    /**
     * 生成预测
     * @param {Object} params - 预测参数 { lottery_type }
     */
    async predict(params) {
      this.loading = true
      this.error = null
      try {
        const res = await getPrediction(params)
        this.result = res
        return res
      } catch (e) {
        this.error = e.message
        throw e
      } finally {
        this.loading = false
      }
    },
    /**
     * 清空预测结果和错误
     */
    clear() {
      this.result = null
      this.error = null
    }
  }
})