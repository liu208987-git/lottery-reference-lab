<template>
  <div class="dashboard-container">
    <el-row :gutter="20">
      <!-- 双色球卡片 -->
      <el-col :xs="24" :sm="12" :md="8">
        <el-card shadow="hover" class="lottery-card">
          <template #header>
            <div class="card-header">
              <span>🟥 双色球最新一期</span>
              <el-button size="small" type="primary" plain @click="fetchLatestSSQ">
                刷新
              </el-button>
            </div>
          </template>
          <div v-if="latestSSQ" class="card-body">
            <div class="issue-row"><strong>期号：</strong>{{ latestSSQ.issue_num }}</div>
            <div class="ball-row">
              <span class="label">红球：</span>
              <el-tag
                v-for="i in 6"
                :key="i"
                size="small"
                type="danger"
                class="ball-tag"
              >
                {{ latestSSQ[`red_${['one','two','three','four','five','six'][i-1]}`] }}
              </el-tag>
            </div>
            <div class="ball-row">
              <span class="label">蓝球：</span>
              <el-tag size="small" type="primary" class="ball-tag">{{ latestSSQ.blue_one }}</el-tag>
            </div>
            <div class="stats-row">
              <span><strong>和值：</strong>{{ latestSSQ.red_summation }}</span>
              <span><strong>跨度：</strong>{{ latestSSQ.red_span }}</span>
            </div>
          </div>
          <div v-else class="empty-state">暂无数据</div>
        </el-card>
      </el-col>

      <!-- 大乐透卡片 -->
      <el-col :xs="24" :sm="12" :md="8">
        <el-card shadow="hover" class="lottery-card">
          <template #header>
            <div class="card-header">
              <span>🟦 大乐透最新一期</span>
              <el-button size="small" type="primary" plain @click="fetchLatestDLT">
                刷新
              </el-button>
            </div>
          </template>
          <div v-if="latestDLT" class="card-body">
            <div class="issue-row"><strong>期号：</strong>{{ latestDLT.issue_num }}</div>
            <div class="ball-row">
              <span class="label">前区：</span>
              <el-tag
                v-for="i in 5"
                :key="i"
                size="small"
                type="warning"
                class="ball-tag"
              >
                {{ latestDLT[`front_${['one','two','three','four','five'][i-1]}`] }}
              </el-tag>
            </div>
            <div class="ball-row">
              <span class="label">后区：</span>
              <el-tag
                v-for="i in 2"
                :key="i"
                size="small"
                type="success"
                class="ball-tag"
              >
                {{ latestDLT[`back_${['one','two'][i-1]}`] }}
              </el-tag>
            </div>
            <div class="stats-row">
              <span><strong>前区和值：</strong>{{ latestDLT.front_summation }}</span>
              <span><strong>跨度：</strong>{{ latestDLT.front_span }}</span>
            </div>
          </div>
          <div v-else class="empty-state">暂无数据</div>
        </el-card>
      </el-col>

      <!-- 模型列表卡片（带分页） -->
      <el-col :xs="24" :sm="24" :md="8">
        <el-card shadow="hover" class="lottery-card model-card">
          <template #header>
            <div class="card-header">
              <span>🧠 已训练模型</span>
              <div class="header-actions">
                <el-badge :value="totalModels" :hidden="totalModels === 0" type="primary">
                  <span style="font-size:13px;color:#909399;">共 {{ totalModels }} 个</span>
                </el-badge>
                <el-button size="small" type="primary" plain @click="fetchModels">
                  刷新
                </el-button>
              </div>
            </div>
          </template>

          <!-- 模型表格 -->
          <el-table
            v-if="paginatedModels.length > 0"
            :data="paginatedModels"
            stripe
            size="small"
            style="width:100%;"
            max-height="280"
          >
            <el-table-column
              prop="name"
              label="模型名称"
              min-width="180"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                <span class="model-name">
                  <el-icon><Document /></el-icon>
                  {{ row.name }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="size"
              label="大小"
              width="80"
              align="center"
            >
              <template #default="{ row }">
                <span class="model-size">{{ row.size || '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column
              label="操作"
              width="80"
              align="center"
              fixed="right"
            >
              <template #default="{ row }">
                <el-button
                  type="primary"
                  link
                  size="small"
                  @click="handleDownload(row.name)"
                >
                  下载
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <!-- 空状态 -->
          <div v-else class="empty-state">暂无模型</div>

          <!-- 分页 -->
          <div v-if="totalModels > 0" class="pagination-wrapper">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[5, 10, 20, 50]"
              :total="totalModels"
              layout="total, sizes, prev, pager, next"
              small
              @size-change="onPageSizeChange"
              @current-change="onPageChange"
            />
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
/**
 * 仪表盘页面
 * 显示最新开奖数据和已训练模型
 */
import { ref, computed, onMounted } from 'vue'
import { getLatestSSQ, getLatestDLT } from '@/api/data'
import { listModels, downloadModel } from '@/api/model'
import { Document } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

// ----- 最新开奖数据 -----
const latestSSQ = ref(null)
const latestDLT = ref(null)

// ----- 模型列表（原始数据） -----
const allModels = ref([])
const loadingModels = ref(false)

// ----- 分页参数 -----
const currentPage = ref(1)
const pageSize = ref(10)

// ----- 计算属性：模型总数 -----
const totalModels = computed(() => allModels.value.length)

// ----- 计算属性：当前页模型数据 -----
const paginatedModels = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return allModels.value.slice(start, end)
})

// ----- 获取最新双色球 -----
const fetchLatestSSQ = async () => {
  try {
    latestSSQ.value = await getLatestSSQ()
  } catch (e) {
    console.error('获取双色球失败:', e)
  }
}

// ----- 获取最新大乐透 -----
const fetchLatestDLT = async () => {
  try {
    latestDLT.value = await getLatestDLT()
  } catch (e) {
    console.error('获取大乐透失败:', e)
  }
}

// ----- 获取模型列表 -----
const fetchModels = async () => {
  loadingModels.value = true
  try {
    const res = await listModels()
    // 只保留 .pt 文件（模型文件），过滤掉 .joblib
    const modelFiles = (res.models || [])
      .filter(name => name.endsWith('.pt'))
      // 按时间戳降序排列（最新在前）
      .sort((a, b) => {
        const timeA = parseInt(a.split('_').pop().replace('.pt', '')) || 0
        const timeB = parseInt(b.split('_').pop().replace('.pt', '')) || 0
        return timeB - timeA
      })
      .map(name => ({
        name,
        size: formatFileSize(name) // 模拟文件大小
      }))
    allModels.value = modelFiles
    // 重置到第一页
    currentPage.value = 1
  } catch (e) {
    console.error('获取模型列表失败:', e)
    ElMessage.error('加载模型列表失败')
  } finally {
    loadingModels.value = false
  }
}

// ----- 格式化文件大小（模拟） -----
const formatFileSize = (name) => {
  // 实际项目可从后端获取文件大小，这里用随机值模拟
  const sizes = ['1.2 MB', '2.5 MB', '3.8 MB', '4.1 MB', '1.8 MB', '2.2 MB', '3.5 MB']
  const idx = name.length % sizes.length
  return sizes[idx] || '2.0 MB'
}

// ----- 下载模型 -----
const handleDownload = async (modelName) => {
  try {
    const blob = await downloadModel(modelName)
    // 创建下载链接
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = modelName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
    ElMessage.success(`开始下载: ${modelName}`)
  } catch (e) {
    console.error('下载失败:', e)
    ElMessage.error('下载失败：' + (e.message || '未知错误'))
  }
}

// ----- 分页事件 -----
const onPageChange = (page) => {
  currentPage.value = page
}

const onPageSizeChange = (size) => {
  pageSize.value = size
  currentPage.value = 1
}

// ----- 生命周期 -----
onMounted(() => {
  fetchLatestSSQ()
  fetchLatestDLT()
  fetchModels()
})
</script>

<style scoped>
/* ===== 页面容器 ===== */
.dashboard-container {
  padding: 20px;
}

@media (max-width: 768px) {
  .dashboard-container {
    padding: 10px;
  }
}

/* ===== 卡片通用 ===== */
.lottery-card {
  height: 100%;
  transition: transform 0.2s;
}
.lottery-card:hover {
  transform: translateY(-2px);
}

/* ===== 卡片头部 ===== */
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ===== 卡片内容 ===== */
.card-body {
  font-size: 14px;
  line-height: 1.8;
}
.issue-row {
  margin-bottom: 8px;
  font-size: 15px;
  color: #303133;
}
.ball-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 6px;
}
.ball-row .label {
  font-weight: 500;
  margin-right: 6px;
  min-width: 36px;
  color: #606266;
}
.ball-tag {
  margin: 2px 4px 2px 0;
  font-weight: 600;
}
.stats-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #ebeef5;
  color: #606266;
}
.stats-row strong {
  color: #303133;
}

/* ===== 空状态 ===== */
.empty-state {
  color: #909399;
  text-align: center;
  padding: 20px 0;
  font-size: 14px;
}

/* ===== 模型卡片 ===== */
.model-card :deep(.el-card__body) {
  padding: 12px 16px 8px;
}
.model-card :deep(.el-table) {
  font-size: 13px;
}
.model-card :deep(.el-table .cell) {
  padding: 4px 0;
}
.model-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
}
.model-name .el-icon {
  font-size: 16px;
  color: #409EFF;
  flex-shrink: 0;
}
.model-size {
  font-size: 12px;
  color: #909399;
}

/* ===== 分页 ===== */
.pagination-wrapper {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid #ebeef5;
  margin-top: 8px;
}
.pagination-wrapper :deep(.el-pagination) {
  padding: 0;
}

/* ===== 移动端适配 ===== */
@media (max-width: 768px) {
  .lottery-card {
    margin-bottom: 16px;
  }
  .card-body {
    font-size: 13px;
  }
  .ball-tag {
    font-size: 12px;
    padding: 0 8px;
    height: 24px;
  }
  .stats-row {
    gap: 12px;
    font-size: 13px;
  }
  .model-card :deep(.el-table) {
    font-size: 12px;
  }
  .model-name {
    font-size: 12px;
  }
  .pagination-wrapper {
    justify-content: center;
  }
  .header-actions {
    gap: 8px;
  }
  .header-actions .el-badge {
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .card-header {
    flex-direction: column;
    align-items: flex-start;
  }
  .header-actions {
    width: 100%;
    justify-content: space-between;
  }
  .model-card :deep(.el-table .cell) {
    padding: 2px 0;
  }
}
</style>