/**
 * 路由权限控制（本系统无需登录，直接放行）
 * 可根据后续需求扩展，例如添加页面标题修改等。
 */
import router from './router'

router.beforeEach((to, from, next) => {
  // 无需验证，直接放行
  next()
})