<template>
  <div class="login">
    <el-card class="panel" shadow="always">
      <h1 class="title">轻量级进销存</h1>
      <p class="subtitle">请先登录后使用</p>

      <el-button
        v-if="auth.provider === 'dingtalk'"
        type="primary"
        size="large"
        class="submit"
        :loading="loading"
        @click="loginByDingtalk"
      >
        钉钉扫码登录
      </el-button>

      <el-form v-else @submit.prevent="loginByMock">
        <el-form-item label="登录名">
          <el-input v-model="name" placeholder="本地开发用户" maxlength="50" />
        </el-form-item>
        <el-button type="primary" size="large" class="submit" :loading="loading" native-type="submit">
          进入系统（本地 mock）
        </el-button>
        <p class="hint">当前 AUTH_PROVIDER=mock，仅用于本地开发；真实扫码登录需在回调域名下联调。</p>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const name = ref('本地开发用户');
const loading = ref(false);

onMounted(async () => {
  if (auth.isLoggedIn) {
    await redirectAfterLogin();
    return;
  }
  try {
    await auth.loadProvider();
  } catch {
    ElMessage.error('无法连接后端服务，请确认已启动');
  }
});

async function redirectAfterLogin(): Promise<void> {
  await auth.fetchMe().catch(() => auth.clear());
  const target = (route.query.redirect as string | undefined) ?? '/dashboard';
  await router.replace(target);
}

async function loginByMock(): Promise<void> {
  loading.value = true;
  try {
    await auth.loginMock(name.value.trim() || '本地开发用户');
    await redirectAfterLogin();
  } catch {
    // 错误提示已在 api client 中统一弹出
  } finally {
    loading.value = false;
  }
}

async function loginByDingtalk(): Promise<void> {
  loading.value = true;
  try {
    const url = await auth.fetchLoginUrl();
    window.location.href = url;
  } catch {
    loading.value = false;
  }
}
</script>

<style scoped>
.login {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}

.panel {
  width: 380px;
}

.title {
  margin: 0;
  font-size: 20px;
  text-align: center;
}

.subtitle {
  margin: 8px 0 24px;
  text-align: center;
  color: #909399;
  font-size: 13px;
}

.submit {
  width: 100%;
}

.hint {
  margin: 16px 0 0;
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
</style>