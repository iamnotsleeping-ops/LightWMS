import type { AuthProvider, AuthUser } from '@light-erp/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getToken, http, setToken } from '@/api/client';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getToken());
  const user = ref<AuthUser | null>(null);
  const provider = ref<AuthProvider>('mock');

  const isLoggedIn = computed(() => Boolean(token.value));
  const permissions = computed(() => user.value?.permissions ?? []);

  function has(code: string): boolean {
    return permissions.value.includes(code);
  }

  function applyToken(value: string): void {
    token.value = value;
    setToken(value);
  }

  function clear(): void {
    token.value = null;
    user.value = null;
    setToken(null);
  }

  async function loadProvider(): Promise<void> {
    const { data } = await http.get<{ provider: AuthProvider }>('/api/auth/config', undefined);
    provider.value = data.provider;
  }

  async function fetchMe(): Promise<AuthUser> {
    const { data } = await http.get<AuthUser>('/api/auth/me');
    user.value = data;
    return data;
  }

  async function loginMock(name: string): Promise<void> {
    const { data } = await http.post<{ token: string; user: AuthUser }>('/api/auth/mock-login', {
      name,
    });
    applyToken(data.token);
    user.value = data.user;
  }

  async function fetchLoginUrl(): Promise<string> {
    const { data } = await http.get<{ url: string }>('/api/auth/dingtalk/url');
    return data.url;
  }

  async function logout(): Promise<void> {
    try {
      await http.post('/api/auth/logout', undefined);
    } finally {
      clear();
    }
  }

  return {
    token,
    user,
    provider,
    isLoggedIn,
    permissions,
    has,
    applyToken,
    clear,
    loadProvider,
    fetchMe,
    loginMock,
    fetchLoginUrl,
    logout,
  };
});