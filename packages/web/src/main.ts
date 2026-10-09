import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { setUnauthorizedHandler } from './api/client';
import { vPermission } from './directives/permission';
import { router } from './router';
import { useAuthStore } from './stores/auth';
import 'element-plus/dist/index.css';
import './styles/global.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.directive('permission', vPermission);

/**
 * 会话失效（401）时同步清理 Pinia store 并跳转登录页。
 * 只清 localStorage 会留下「僵尸会话」：界面仍是登录态、菜单照常显示，但请求全部 401。
 */
setUnauthorizedHandler(() => {
  const auth = useAuthStore();
  auth.clear();
  const current = router.currentRoute.value;
  if (current.path === '/login' || current.meta.public) return;
  void router.replace({ path: '/login', query: { redirect: current.fullPath } });
});

app.mount('#app');