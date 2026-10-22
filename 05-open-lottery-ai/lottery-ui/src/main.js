/**
 * 应用入口文件
 * 初始化 Vue 应用，注册全局插件（Pinia、Vue Router、Element Plus）
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import './permission' // 路由守卫（本系统为开放，直接放行）

const app = createApp(App)
const pinia = createPinia()

// 注册 Element Plus 所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(pinia)
app.use(router)
app.use(ElementPlus)
app.mount('#app')