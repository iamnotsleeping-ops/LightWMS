<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="brand">轻量级进销存</div>
      <el-menu :default-active="route.path" router class="menu">
        <template v-for="group in menus" :key="group.title">
          <el-menu-item v-if="!group.children" :index="group.path ?? group.title">
            {{ group.title }}
          </el-menu-item>
          <el-sub-menu v-else :index="group.title">
            <template #title>{{ group.title }}</template>
            <el-menu-item
              v-for="child in group.children"
              :key="child.title"
              :index="child.path ?? child.title"
              :disabled="!child.path"
            >
              {{ child.title }}
            </el-menu-item>
          </el-sub-menu>
        </template>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title ?? '' }}</span>
        <el-dropdown class="user" @command="onCommand">
          <span class="user-trigger">
            {{ auth.user?.name ?? '未登录' }}
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>
                {{ roleText }}
              </el-dropdown-item>
              <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { visibleMenus } from './menu';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const menus = computed(() => visibleMenus((code) => auth.has(code)));
const roleText = computed(() => auth.user?.roles.map((role) => role.name).join('、') || '未分配角色');

async function onCommand(command: string): Promise<void> {
  if (command !== 'logout') return;
  await ElMessageBox.confirm('确认退出登录？', '提示', { type: 'warning' });
  await auth.logout();
  await router.replace('/login');
}
</script>

<style scoped>
.layout {
  height: 100%;
}

.aside {
  background: #fff;
  border-right: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
}

.brand {
  height: 60px;
  display: flex;
  align-items: center;
  padding: 0 20px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid #e4e7ed;
}

.menu {
  border-right: none;
  flex: 1;
  overflow-y: auto;
}

.header {
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  font-size: 15px;
  font-weight: 600;
}

.user-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: #303133;
  outline: none;
}

.main {
  padding: 16px;
  overflow-y: auto;
}
</style>