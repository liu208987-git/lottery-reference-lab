<template>
  <div class="predict-container">
    <el-card>
      <template #header>🔮 生成预测</template>
      <el-form label-width="120px" label-position="top" class="predict-form">
        <el-form-item label="彩种">
          <el-radio-group v-model="lotteryType" @change="onLotteryChange">
            <el-radio value="ssq">双色球</el-radio>
            <el-radio value="dlt">大乐透</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="选择模型">
          <div class="model-select-wrapper">
            <el-select
              v-model="selectedModels"
              multiple
              placeholder="输入模型名搜索，支持多选"
              style="width:100%;"
              filterable
              collapse-tags
              collapse-tags-tooltip
              :disabled="modelOptions.length === 0"
              @change="onModelChange"
            >
              <el-option
                key="__select_all__"
                label="☑️ 全选"
                value="__select_all__"
                style="font-weight:bold;color:#409EFF;"
              />
              <el-option
                v-for="item in modelOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              >
                <div class="model-option">
                  <span class="model-option-label">{{ item.label }}</span>
                  <el-tag size="small" type="info" round class="model-option-tag">.pt</el-tag>
                </div>
              </el-option>
            </el-select>

            <div class="model-select-actions">
              <div class="model-stat">
                <span class="stat-text">共 <strong>{{ modelOptions.length }}</strong> 个模型</span>
                <span class="stat-divider">|</span>
                <span class="stat-text">已选 <strong class="selected-count">{{ selectedModels.length }}</strong> 个</span>
              </div>
              <el-button
                v-if="selectedModels.length > 0"
                size="small"
                type="danger"
                plain
                @click="clearAllSelection"
                class="clear-btn"
              >
                <el-icon><Close /></el-icon> 清空已选
              </el-button>
            </div>
          </div>
        </el-form-item>

        <el-form-item>
          <div class="btn-group">
            <el-button type="success" plain @click="handleAgentSelectModels" :loading="agentSelectLoading">
              <el-icon><MagicStick /></el-icon> 智能选择并预测
            </el-button>
            <el-button
              type="primary"
              @click="handlePredict"
              :loading="loading"
              :disabled="!selectedModels.length"
            >
              {{ selectedModels.length > 0 ? `预测 (${selectedModels.length})` : '预测' }}
            </el-button>
            <el-button @click="handleClear">清空结果</el-button>
            <el-button @click="loadModels" :loading="loadingModels">刷新模型列表</el-button>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <div v-if="results.length > 0" style="margin-top:20px;">
      <el-row :gutter="20">
        <el-col
          v-for="(item, index) in results"
          :key="index"
          :xs="24"
          :sm="12"
          :md="12"
          :lg="8"
        >
          <el-card class="result-card" shadow="hover">
            <template #header>
              <div class="result-header">
                <span class="model-name">{{ item.modelName }}</span>
                <el-tag :type="item.success ? 'success' : 'danger'" size="small">
                  {{ item.success ? '成功' : '失败' }}
                </el-tag>
              </div>
            </template>
            <div v-if="item.success" class="result-content">
              <p><strong>彩种：</strong>{{ item.data.lottery_type === 'ssq' ? '双色球' : '大乐透' }}</p>
              <p><strong>预测日期：</strong>{{ item.data.forecast_date }}</p>
              <p class="ball-row">
                <strong>红球（前区）：</strong>
                <el-tag
                  v-for="r in item.data.red"
                  :key="r"
                  size="default"
                  class="result-tag"
                >{{ r }}</el-tag>
              </p>
              <p class="ball-row">
                <strong>蓝球（后区）：</strong>
                <el-tag
                  v-for="b in item.data.blue"
                  :key="b"
                  size="default"
                  type="danger"
                  class="result-tag"
                >{{ b }}</el-tag>
              </p>
              <p><strong>质量评分：</strong>{{ item.data.quality_score }}</p>
              <p><strong>模型版本：</strong>{{ item.data.model_version }}</p>
            </div>
            <div v-else class="error-msg">
              <el-alert type="error" :title="item.error" show-icon />
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <el-alert
      v-if="globalError"
      type="error"
      :title="globalError"
      show-icon
      closable
      @close="globalError = null"
      style="margin-top:20px;"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import { listModels } from '@/api/model'
import { getPrediction } from '@/api/predict'
import { ElMessage } from 'element-plus'
import { Close, MagicStick } from '@element-plus/icons-vue'
import request from '@/utils/request'

const lotteryType = ref('ssq')
const selectedModels = ref([])
const modelOptions = ref([])
const results = ref([])
const loading = ref(false)
const loadingModels = ref(false)
const globalError = ref(null)
const agentSelectLoading = ref(false)

const actualModelOptions = computed(() => {
  return modelOptions.value.filter(item => item.value !== '__select_all__')
})

// ===== 修复 loadModels =====
const loadModels = async () => {
  loadingModels.value = true
  try {
    const res = await listModels()
    console.log('[loadModels] API 原始响应:', res)

    // 兼容 res 或 res.data
    const data = res.data || res
    const allModels = data.models || []
    console.log('[loadModels] 提取的模型列表:', allModels)

    const prefix = lotteryType.value
    const filtered = allModels
      .filter(name => name.endsWith('.pt') && name.startsWith(prefix))
      .filter(name => !name.includes('_final'))
      .map(name => {
        const base = name.replace('.pt', '')
        const parts = base.split('_')
        let label = base
        if (parts.length >= 5) {
          const epochPart = parts.find(p => p.startsWith('epochs')) || ''
          const bsPart = parts.find(p => p.startsWith('bs')) || ''
          const seqPart = parts.find(p => p.startsWith('seq')) || ''
          const lrPart = parts.find(p => p.startsWith('lr')) || ''
          const timePart = parts[parts.length - 1] || ''
          label = `E${epochPart.replace('epochs','')} B${bsPart.replace('bs','')} S${seqPart.replace('seq','')} L${lrPart.replace('lr','').replace('_','.')} (${timePart})`
        }
        return { value: name, label: label }
      })
    filtered.sort((a, b) => {
      const timeA = parseInt(a.value.split('_').pop().replace('.pt','')) || 0
      const timeB = parseInt(b.value.split('_').pop().replace('.pt','')) || 0
      return timeB - timeA
    })
    modelOptions.value = filtered
    console.log('[loadModels] 最终 modelOptions:', modelOptions.value)

    // 清除已选但不再存在的模型
    selectedModels.value = selectedModels.value.filter(m =>
      filtered.some(item => item.value === m)
    )

    if (filtered.length === 0) {
      ElMessage.warning(`当前彩种 ${lotteryType.value === 'ssq' ? '双色球' : '大乐透'} 暂无可用模型，请先训练`)
    }
  } catch (e) {
    console.error('[loadModels] 加载失败:', e)
    ElMessage.error('加载模型列表失败')
  } finally {
    loadingModels.value = false
  }
}

const onLotteryChange = () => {
  selectedModels.value = []
  results.value = []
  globalError.value = null
  loadModels()
}

const onModelChange = (val) => {
  const hasSelectAll = val.includes('__select_all__')
  const actualModels = actualModelOptions.value.map(item => item.value)

  if (hasSelectAll) {
    const isAllSelected = actualModels.every(m => val.includes(m))
    if (isAllSelected) {
      selectedModels.value = []
    } else {
      selectedModels.value = actualModels
    }
    const cleanVal = selectedModels.value.filter(v => v !== '__select_all__')
    selectedModels.value = cleanVal
  }
}

const clearAllSelection = () => {
  selectedModels.value = []
  ElMessage.info('已清空所有选择')
}

const BATCH_SIZE = 10

const handlePredict = async () => {
  if (selectedModels.value.length === 0) {
    ElMessage.warning('请至少选择一个模型')
    return
  }

  loading.value = true
  globalError.value = null
  results.value = []

  const allModels = selectedModels.value
  const total = allModels.length
  let completed = 0
  const allResults = []

  for (let i = 0; i < allModels.length; i += BATCH_SIZE) {
    const batch = allModels.slice(i, i + BATCH_SIZE)
    const promises = batch.map(async (modelName) => {
      try {
        const data = await getPrediction({
          lottery_type: lotteryType.value,
          model_name: modelName
        })
        return { modelName, success: true, data }
      } catch (error) {
        let msg = error.message || '预测失败'
        if (error.code === 'ECONNABORTED') {
          msg = '请求超时，请稍后重试'
        } else if (error.response?.status === 404) {
          msg = '模型文件不存在，请确认模型已训练'
        } else if (error.response?.status === 500) {
          msg = '服务器处理异常，请稍后重试'
        }
        return { modelName, success: false, error: msg }
      }
    })

    const batchResults = await Promise.allSettled(promises)
    const finalBatch = batchResults.map((item, index) => {
      if (item.status === 'fulfilled') {
        return item.value
      } else {
        return {
          modelName: batch[index] || '未知模型',
          success: false,
          error: item.reason?.message || '请求异常'
        }
      }
    })

    allResults.push(...finalBatch)
    completed += batch.length
    ElMessage.info(`进度：${completed}/${total} 个模型`)
  }

  results.value = allResults

  const successCount = allResults.filter(r => r.success).length
  if (successCount === allResults.length) {
    ElMessage.success(`全部 ${successCount} 个模型预测成功`)
  } else if (successCount > 0) {
    ElMessage.warning(`${successCount}/${allResults.length} 个模型预测成功，请查看详情`)
  } else {
    ElMessage.error('所有模型预测均失败')
  }

  loading.value = false
}

const handleClear = () => {
  results.value = []
  globalError.value = null
}

// ===== 修复 handleAgentSelectModels（只选存在的模型） =====
// ===== 智能选择模型并自动预测（增强版：无匹配时选择全部） =====
const handleAgentSelectModels = async () => {
  if (!lotteryType.value) {
    ElMessage.warning('请先选择彩种')
    return
  }

  // 先刷新模型列表
  await loadModels()
  if (modelOptions.value.length === 0) {
    ElMessage.warning('暂无可用模型，请先训练')
    return
  }

  agentSelectLoading.value = true
  try {
    console.log('[Agent] 请求模型推荐...')
    const res = await request({
      url: `/agent/recommend-models/${lotteryType.value}`,
      method: 'get'
    })
    console.log('[Agent] 推荐响应:', res)

    const modelList = res.models || res.data?.models || []
    console.log('[Agent] 推荐模型列表:', modelList)

    if (!Array.isArray(modelList) || modelList.length === 0) {
      ElMessage.warning('暂无推荐模型，将选择当前所有模型')
      selectedModels.value = modelOptions.value.map(item => item.value)
      await nextTick()
      await handlePredict()
      return
    }

    const availableModelNames = modelOptions.value.map(item => item.value)
    console.log('[Agent] 当前可用模型:', availableModelNames)

    let validModels = modelList.filter(name => availableModelNames.includes(name))
    console.log('[Agent] 匹配到的模型:', validModels)

    if (validModels.length === 0) {
      // 若没有匹配，选择当前所有模型
      ElMessage.warning('推荐的模型都不在当前列表中，将选择当前所有模型进行预测')
      validModels = availableModelNames
    } else if (validModels.length < modelList.length) {
      ElMessage.info(`推荐模型中有 ${modelList.length - validModels.length} 个不在当前列表中，将只使用存在的 ${validModels.length} 个`)
    }

    selectedModels.value = validModels
    ElMessage.success(`已选择 ${validModels.length} 个模型，开始预测...`)

    await nextTick()
    await handlePredict()

  } catch (e) {
    const msg = e.response?.data?.detail || e.message || '智能选择失败'
    console.error('[Agent] 错误:', e)
    ElMessage.error('智能选择失败：' + msg)
  } finally {
    agentSelectLoading.value = false
  }
}

onMounted(() => {
  loadModels()
})
</script>

<style scoped>
/* ... 样式保持不变 ... */
.predict-container { padding: 0; }
.predict-form .el-form-item { margin-bottom: 18px; }
.model-select-wrapper { width: 100%; }
.model-option { display: flex; justify-content: space-between; align-items: center; width: 100%; }
.model-option-label { font-size: 13px; font-family: 'Consolas', 'Courier New', monospace; color: #303133; }
.model-option-tag { font-size: 10px; opacity: 0.7; flex-shrink: 0; }
.model-select-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
  gap: 8px;
}
.model-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #909399;
}
.stat-text { color: #606266; }
.stat-text strong { color: #303133; }
.stat-text .selected-count { color: #409EFF; font-weight: 700; font-size: 15px; }
.stat-divider { color: #dcdfe6; margin: 0 4px; }
.clear-btn { font-size: 12px; padding: 4px 10px; height: 28px; }
.clear-btn .el-icon { font-size: 14px; }
.btn-group .el-button--primary { min-width: 120px; }
.btn-group {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.btn-group .el-button { flex: 1 0 auto; min-width: 80px; }
.result-card { margin-bottom: 20px; height: 100%; }
.result-header { display: flex; justify-content: space-between; align-items: center; }
.model-name { font-weight: bold; font-size: 14px; color: #303133; }
.result-content { font-size: 14px; line-height: 1.8; }
.ball-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.result-tag { margin: 2px 0; }
.error-msg { padding: 10px 0; }
@media (max-width: 768px) {
  .predict-form .el-form-item { margin-bottom: 14px; }
  .result-content { font-size: 13px; }
  .result-tag { font-size: 13px; padding: 0 10px; height: 28px; }
  .model-select-actions { flex-direction: column; align-items: stretch; gap: 6px; }
  .model-stat { justify-content: center; font-size: 12px; }
  .clear-btn { align-self: center; }
  .btn-group .el-button--primary { min-width: 80px; }
}
</style>