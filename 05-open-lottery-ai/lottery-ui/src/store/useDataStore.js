/**
 * 数据状态管理（Pinia Store）
 * 管理双色球和大乐透的列表数据及最新数据
 */
import { defineStore } from 'pinia'
import { listSSQData, getLatestSSQ, listDLTData, getLatestDLT } from '@/api/data'

export const useDataStore = defineStore('data', {
  state: () => ({
    ssqData: [],          // 双色球列表
    dltData: [],          // 大乐透列表
    latestSSQ: null,      // 最新双色球
    latestDLT: null,      // 最新大乐透
    loading: false        // 加载状态
  }),
  actions: {
    /**
     * 获取双色球列表（分页）
     * @param {Object} params - 分页参数
     */
    async fetchSSQ(params) {
      this.loading = true
      try {
        const res = await listSSQData(params)
        this.ssqData = res.items || []
        return res
      } finally {
        this.loading = false
      }
    },
    /**
     * 获取最新双色球
     */
    async fetchLatestSSQ() {
      this.latestSSQ = await getLatestSSQ()
      return this.latestSSQ
    },
    /**
     * 获取大乐透列表（分页）
     * @param {Object} params - 分页参数
     */
    async fetchDLT(params) {
      this.loading = true
      try {
        const res = await listDLTData(params)
        this.dltData = res.items || []
        return res
      } finally {
        this.loading = false
      }
    },
    /**
     * 获取最新大乐透
     */
    async fetchLatestDLT() {
      this.latestDLT = await getLatestDLT()
      return this.latestDLT
    }
  }
})