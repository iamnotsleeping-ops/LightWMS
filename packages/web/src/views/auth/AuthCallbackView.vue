<template>
  <div class="callback">
    <el-result
      :icon="icon"
      :title="title"
      :sub-title="subtitle"
    >
      <template #extra>
        <el-button type="primary" @click="goLogin">返回登录页</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const icon = ref<'success' | 'error' | 'warning'>('success');
const title = ref('正在登录…');
const subtitle = ref('');

onMounted(async () => {
  const error = route.query.error as string | undefined;
  if (error) {
    icon.value = 'error';
    title.value = '登录失败';
    subtitle.value = error;
    return;
  }

  const token = route.query.token as string | undefined;
  if (!token) {
    icon.value = 'warning';
    title.value = '缺少登录凭证';
    subtitle.value = '请重新发起登录';
    return;
  }

  auth.applyToken(token);
  try {
    await auth.fetchMe();
    await router.replace('/dashboard');
  } catch {
    auth.clear();
    icon.value = 'error';
    title.value = '登录失败';
    subtitle.value = '会话校验未通过，请重新登录';
  }
});

async function goLogin(): Promise<void> {
  await router.replace('/login');
}
</script>

<style scoped>
.callback {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}
</style>