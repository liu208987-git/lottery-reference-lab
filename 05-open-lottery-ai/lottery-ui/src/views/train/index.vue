<template>
  <div class="train-container">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>⚙️ 训练配置</span>
          <el-button link @click="showHelp = !showHelp" style="font-size:14px;">
            {{ showHelp ? '收起参数说明 ▲' : '展开参数说明 ▼' }}
          </el-button>
        </div>
      </template>

      <el-collapse-transition>
        <div v-show="showHelp" class="help-table">
          <el-table :data="helpData" border size="small" style="width:100%;">
            <el-table-column prop="param" label="参数" width="120" />
            <el-table-column prop="desc" label="说明" />
            <el-table-column prop="range" label="取值范围" width="160" />
            <el-table-column prop="recommend" label="推荐值" width="140" />
          </el-table>
        </div>
      </el-collapse-transition>

      <el-form label-width="120px" label-position="top" class="train-form">
        <el-form-item label="彩种">
          <el-radio-group v-model="lotteryType" @change="onLotteryChange">
            <el-radio value="ssq">双色球</el-radio>
            <el-radio value="dlt">大乐透</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="训练轮数">
          <el-input-number v-model="epochs" :min="1" :max="500" style="width: 100%" />
        </el-form-item>

        <el-form-item label="批次大小">
          <el-input-number v-model="batchSize" :min="1" :max="256" style="width: 100%" />
        </el-form-item>

        <el-form-item label="序列长度">
          <el-input-number
            v-model="seqLen"
            :min="10"
            :max="seqLenMax"
            style="width: 100%"
          />
          <div style="color:#909399;font-size:12px;margin-top:4px;">
            当前彩种数据总量：{{ totalCount }} 期，最大可输入：{{ seqLenMax }}
            <span style="color:#E6A23C;margin-left:10px;">
              （实际训练时最大可用为 {{ Math.max(10, totalCount - 1) }}）
            </span>
          </div>
        </el-form-item>

        <el-form-item label="学习率">
          <el-input-number v-model="learningRate" :step="0.00001" :precision="5" style="width: 100%" />
        </el-form-item>

        <el-form-item label="训练前更新数据">
          <el-switch v-model="withFetch" active-text="开启" inactive-text="关闭" />
          <span style="margin-left:10px;color:#909399;font-size:12px;">开启后将先抓取最新开奖数据</span>
        </el-form-item>

        <el-form-item>
          <div class="btn-group">
            <el-button type="success" plain @click="handleAgentRecommend" :loading="agentLoading">
              <el-icon><MagicStick /></el-icon> 智能推荐并完整训练
            </el-button>
            <el-button type="primary" @click="handleStart" :loading="trainStore.loading">
              {{ withFetch ? '一键完整训练' : '开始训练' }}
            </el-button>
            <el-button @click="handleCheckStatus" :disabled="!trainStore.taskId">查询状态</el-button>
            <el-button @click="handleReset">重置</el-button>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-if="trainStore.taskId" style="margin-top:20px">
      <template #header>📊 训练状态</template>
      <div class="status-content">
        <p><strong>任务 ID：</strong>{{ trainStore.taskId }}</p>
        <p><strong>状态：</strong>
          <el-tag :type="statusTagType">{{ statusText }}</el-tag>
        </p>
        <p v-if="trainStore.status?.meta?.stage">
          <strong>当前阶段：</strong>
          <el-tag size="small" :type="stageTagType">{{ stageText }}</el-tag>
        </p>
        <pre v-if="trainStore.status?.result" class="result-pre">{{ JSON.stringify(trainStore.status.result, null, 2) }}</pre>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, getCurrentInstance } from 'vue'
import { useTrainStore } from '@/store'
import { ElMessage } from 'element-plus'
import { MagicStick } from '@element-plus/icons-vue'
import { listSSQData, listDLTData } from '@/api/data'
import request from '@/utils/request'

const { proxy } = getCurrentInstance()
const trainStore = useTrainStore()

const lotteryType = ref('ssq')
const epochs = ref(200)
const batchSize = ref(128)
const seqLen = ref(30)
const learningRate = ref(0.00005)
const withFetch = ref(true)
const showHelp = ref(false)
const agentLoading = ref(false)

const totalCount = ref(0)
const seqLenMax = ref(3000)

const helpData = [
  { param: '彩种', desc: '选择要训练的彩票类型', range: '双色球 / 大乐透', recommend: '按需选择' },
  { param: '训练轮数', desc: '训练迭代轮数，越大模型越收敛', range: '1 - 500', recommend: '200 - 300' },
  { param: '批次大小', desc: '每次迭代使用的样本数', range: '1 - 256', recommend: '64 - 128' },
  { param: '序列长度', desc: '使用多少期历史数据预测下一期', range: `10 - ${seqLenMax.value}`, recommend: '30 - 50' },
  { param: '学习率', desc: '模型参数更新步长，越小收敛越精细', range: '0.00001 - 0.01', recommend: '0.00005 - 0.0001' },
  { param: '更新数据', desc: '训练前是否先抓取最新开奖数据', range: '开启 / 关闭', recommend: '开启' }
]

const fetchTotalCount = async () => {
  try {
    const res = lotteryType.value === 'ssq'
      ? await listSSQData({ limit: 1 })
      : await listDLTData({ limit: 1 })
    const total = res.total || 0
    totalCount.value = total
    seqLenMax.value = Math.max(10, total)
    if (seqLen.value > seqLenMax.value) {
      seqLen.value = seqLenMax.value
    }
    helpData[3].range = `10 - ${seqLenMax.value}`
  } catch (e) {
    console.error('获取数据总量失败:', e)
    totalCount.value = 0
    seqLenMax.value = 3000
    ElMessage.warning('获取数据总量失败，请检查后端服务')
  }
}

const onLotteryChange = () => {
  fetchTotalCount()
}

const statusText = computed(() => {
  const map = { pending: '等待中', running: '训练中...', completed: '已完成 ✅', failed: '失败 ❌', fetching: '数据更新中...' }
  return map[trainStore.status?.status] || '未知'
})

const statusTagType = computed(() => {
  const map = { completed: 'success', failed: 'danger', running: 'warning', fetching: 'warning' }
  return map[trainStore.status?.status] || 'info'
})

const stageText = computed(() => {
  const map = { fetch: '抓取数据', train: '训练模型', done: '已完成' }
  return map[trainStore.status?.meta?.stage] || '未知'
})

const stageTagType = computed(() => {
  const map = { fetch: 'warning', train: 'primary', done: 'success' }
  return map[trainStore.status?.meta?.stage] || 'info'
})

let pollTimer = null

const pollStatus = async () => {
  if (!trainStore.taskId) return
  try {
    const res = await trainStore.fetchStatus(trainStore.taskId)
    const status = res.status
    if (status === 'completed' || status === 'failed' || status === 'SUCCESS' || status === 'FAILURE') {
      ElMessage.info(`训练${status === 'completed' || status === 'SUCCESS' ? '完成' : '失败'}`)
      return
    }
    pollTimer = setTimeout(pollStatus, 5000)
  } catch {
    pollTimer = setTimeout(pollStatus, 5000)
  }
}

const handleStart = async () => {
  console.log('[handleStart] 被调用，当前参数:', {
    lotteryType: lotteryType.value,
    epochs: epochs.value,
    batchSize: batchSize.value,
    seqLen: seqLen.value,
    learningRate: learningRate.value,
    withFetch: withFetch.value
  })

  if (totalCount.value > 0 && seqLen.value > totalCount.value - 1) {
    const adjusted = totalCount.value - 1
    ElMessage.warning(`序列长度 ${seqLen.value} 超过最大可用值 ${adjusted}，已自动调整为 ${adjusted}`)
    seqLen.value = adjusted
  }
  if (seqLen.value > seqLenMax.value || seqLen.value < 10) {
    ElMessage.error(`序列长度必须在 10 到 ${seqLenMax.value} 之间`)
    return
  }
  try {
    const params = {
      lottery_type: lotteryType.value,
      epochs: epochs.value,
      batch_size: batchSize.value,
      seq_len: seqLen.value,
      learning_rate: learningRate.value,
      with_fetch: withFetch.value
    }
    console.log('[handleStart] 提交参数:', params)
    await trainStore.start(params)
    ElMessage.success(`任务已提交，ID: ${trainStore.taskId}`)
    pollStatus()
  } catch (e) {
    console.error('[handleStart] 提交失败:', e)
    ElMessage.error('提交失败：' + e.message)
  }
}

const handleCheckStatus = async () => {
  if (!trainStore.taskId) return
  await trainStore.fetchStatus(trainStore.taskId)
  ElMessage.info(`当前状态: ${trainStore.status?.status}`)
}

const handleReset = () => {
  trainStore.reset()
  if (pollTimer) clearTimeout(pollTimer)
  lotteryType.value = 'ssq'
  epochs.value = 200
  batchSize.value = 128
  seqLen.value = 30
  learningRate.value = 0.00005
  withFetch.value = true
  fetchTotalCount()
}

// ===== handleAgentRecommend =====
/**
 * 🤖 AI 智能推荐并完整训练
 */
const handleAgentRecommend = async () => {
  if (!lotteryType.value) {
    ElMessage.warning('请先选择彩种')
    return
  }

  agentLoading.value = true
  try {
    console.log('[Agent] 开始请求推荐...')
    const res = await request({
      url: '/agent/recommend-hyperparams',
      method: 'post',
      data: {
        lottery_type: lotteryType.value,
        description: ''
      }
    })
    console.log('[Agent] 完整响应:', res)

    // 兼容两种情况：res 是数据本身，或 res.data 是数据
    const result = res.data || res
    console.log('[Agent] 提取的结果:', result)

    if (result && result.epochs !== undefined) {
      // 填充参数
      epochs.value = result.epochs
      batchSize.value = result.batch_size
      seqLen.value = result.seq_len
      learningRate.value = result.learning_rate
      // 强制开启数据更新
      withFetch.value = true

      if (result.reason) {
        ElMessage.success(`推荐成功：${result.reason}，自动开始完整训练...`)
      } else {
        ElMessage.success('推荐成功，自动开始完整训练...')
      }

      // 等待 DOM 更新
      await nextTick()
      console.log('[Agent] 准备调用 handleStart，参数:', {
        lotteryType: lotteryType.value,
        epochs: epochs.value,
        batchSize: batchSize.value,
        seqLen: seqLen.value,
        learningRate: learningRate.value,
        withFetch: withFetch.value
      })

      // 直接调用训练提交
      await handleStart()
      console.log('[Agent] handleStart 执行完毕')
    } else {
      ElMessage.error('推荐返回数据格式异常，请检查后端')
    }
  } catch (e) {
    const msg = e.response?.data?.detail || e.message || '推荐失败'
    console.error('[Agent] 错误:', e)
    ElMessage.error('智能推荐失败：' + msg)
  } finally {
    agentLoading.value = false
  }
}

onMounted(() => {
  fetchTotalCount()
})

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})
</script>

<style scoped>
.train-container { padding: 0; }
.train-form .el-form-item { margin-bottom: 18px; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.help-table { margin-bottom: 20px; padding: 12px 0; border-top: 1px solid #ebeef5; }
.btn-group { display: flex; flex-wrap: wrap; gap: 10px; }
.btn-group .el-button { flex: 1 0 auto; min-width: 80px; }
.status-content { font-size: 14px; line-height: 1.8; }
.result-pre { background: #f5f7fa; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 13px; }
@media (max-width: 768px) {
  .train-form .el-form-item { margin-bottom: 14px; }
  .train-form .el-form-item__label { padding-bottom: 4px; }
  .help-table { font-size: 12px; }
}
</style>