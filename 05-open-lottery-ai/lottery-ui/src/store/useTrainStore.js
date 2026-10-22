/**
 * 训练状态管理（Pinia Store）
 * 管理训练任务提交、状态查询和重置
 */
import { defineStore } from 'pinia'
import { startTraining, getTrainStatus } from '@/api/train'

export const useTrainStore = defineStore('train', {
  state: () => ({
    taskId: null,       // 当前任务 ID
    status: null,       // 任务状态对象
    loading: false      // 提交加载状态
  }),
  actions: {
    /**
     * 提交训练任务
     * @param {Object} params - 训练参数
     */
    async start(params) {
      this.loading = true
      try {
        const res = await startTraining(params)
        this.taskId = res.task_id
        return res
      } finally {
        this.loading = false
      }
    },
    /**
     * 查询训练状态
     * @param {string} taskId - 任务 ID
     */
    async fetchStatus(taskId) {
      const res = await getTrainStatus(taskId)
      this.status = res
      return res
    },
    /**
     * 重置状态
     */
    reset() {
      this.taskId = null
      this.status = null
      this.loading = false
    }
  }
})