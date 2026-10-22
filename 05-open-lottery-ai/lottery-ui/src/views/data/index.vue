<template>
  <div class="data-container">
    <el-tabs v-model="activeTab">
      <!-- 双色球 Tab -->
      <el-tab-pane label="双色球" name="ssq">
        <el-table :data="ssqData" border stripe style="width: 100%; overflow-x: auto">
          <el-table-column prop="issue_num" label="期号" width="120" />
          <el-table-column prop="draw_date" label="日期" width="120" />
          <el-table-column label="红球" min-width="200">
            <template #default="{ row }">
              <el-tag
                v-for="i in 6"
                :key="i"
                size="small"
                style="margin:2px"
              >
                {{ row[`red_${['one','two','three','four','five','six'][i-1]}`] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="蓝球" width="100">
            <template #default="{ row }">
              <el-tag type="danger" size="small">{{ row.blue_one }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="red_summation" label="和值" width="80" />
          <el-table-column prop="red_span" label="跨度" width="80" />
        </el-table>

        <!-- 分页组件 -->
        <div class="pagination-wrapper">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="total"
            @current-change="loadSSQ"
            :layout="isMobile ? 'prev, pager, next' : 'prev, pager, next, total'"
            size="small"
            class="mobile-pagination"
          />
        </div>
      </el-tab-pane>

      <!-- 大乐透 Tab -->
      <el-tab-pane label="大乐透" name="dlt">
        <el-table :data="dltData" border stripe style="width: 100%; overflow-x: auto">
          <el-table-column prop="issue_num" label="期号" width="120" />
          <el-table-column prop="draw_date" label="日期" width="120" />
          <el-table-column label="前区" min-width="180">
            <template #default="{ row }">
              <el-tag
                v-for="i in 5"
                :key="i"
                size="small"
                style="margin:2px"
              >
                {{ row[`front_${['one','two','three','four','five'][i-1]}`] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="后区" width="120">
            <template #default="{ row }">
              <el-tag
                v-for="i in 2"
                :key="i"
                size="small"
                type="warning"
                style="margin:2px"
              >
                {{ row[`back_${['one','two'][i-1]}`] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="front_summation" label="和值" width="80" />
          <el-table-column prop="front_span" label="跨度" width="80" />
        </el-table>

        <!-- 分页组件 -->
        <div class="pagination-wrapper">
          <el-pagination
            v-model:current-page="dltPage"
            v-model:page-size="dltPageSize"
            :total="dltTotal"
            @current-change="loadDLT"
            :layout="isMobile ? 'prev, pager, next' : 'prev, pager, next, total'"
            size="small"
            class="mobile-pagination"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, computed } from 'vue'
// 推荐使用 @vueuse/core 提供响应式窗口尺寸，如未安装可用注释中的备用方案
import { useWindowSize } from '@vueuse/core'
import { listSSQData, listDLTData } from '@/api/data'

// ---------- 响应式窗口判断 ----------
const { width } = useWindowSize()
const isMobile = computed(() => width.value < 768)

// ---------- 双色球状态 ----------
const activeTab = ref('ssq')
const ssqData = ref([])
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)

// ---------- 大乐透状态 ----------
const dltData = ref([])
const dltPage = ref(1)
const dltPageSize = ref(20)
const dltTotal = ref(0)

// ---------- 加载函数 ----------
const loadSSQ = async () => {
  console.log('加载双色球，页码:', page.value) // 调试用
  try {
    const res = await listSSQData({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value
    })
    ssqData.value = res.items || []
    total.value = res.total || 0
  } catch (e) {
    console.error('加载双色球失败:', e)
  }
}

const loadDLT = async () => {
  console.log('加载大乐透，页码:', dltPage.value) // 调试用
  try {
    const res = await listDLTData({
      limit: dltPageSize.value,
      offset: (dltPage.value - 1) * dltPageSize.value
    })
    dltData.value = res.items || []
    dltTotal.value = res.total || 0
  } catch (e) {
    console.error('加载大乐透失败:', e)
  }
}

// ---------- 切换标签自动加载 ----------
watch(activeTab, (newTab) => {
  if (newTab === 'dlt' && dltData.value.length === 0) {
    loadDLT()
  }
  if (newTab === 'ssq' && ssqData.value.length === 0) {
    loadSSQ()
  }
})

// ---------- 生命周期 ----------
onMounted(() => {
  loadSSQ()
  // 如果想一开始就预加载大乐透，取消下面注释
  // loadDLT()
})
</script>

<style scoped>
.data-container {
  padding: 0;
}

.pagination-wrapper {
  margin-top: 15px;
  display: flex;
  justify-content: center;
}

/* 分页组件自定义尺寸（PC 端） */
.mobile-pagination {
  --el-pagination-button-size: 32px;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .pagination-wrapper {
    justify-content: center;
  }

  /* 增大点击区域，方便触摸 */
  .mobile-pagination {
    --el-pagination-button-size: 40px;
  }

  .el-pagination .btn-prev,
  .el-pagination .btn-next,
  .el-pagination .el-pager li {
    min-width: 40px !important;
    height: 40px !important;
    line-height: 40px !important;
  }

  .el-pagination .el-pager li {
    font-size: 14px;
  }

  /* 表格字体略微缩小，避免拥挤（可选） */
  .el-table {
    font-size: 13px;
  }
}
</style>