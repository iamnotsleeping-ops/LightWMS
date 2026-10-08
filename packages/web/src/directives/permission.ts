import type { PermissionCode } from '@light-erp/shared';
import type { Directive } from 'vue';
import { useAuthStore } from '@/stores/auth';

/**
 * 按钮级权限：无对应权限码时移除该元素。
 *
 * 用法：`<el-button v-permission="PERMISSIONS.purchaseOrderManage">新建</el-button>`
 *
 * 仅用于「单个元素、单一权限」的简单场景；若条件中还含其它逻辑
 * （如「有权限且单据为草稿」），请改用 `computed` + `v-if`。
 */
export const vPermission: Directive<HTMLElement, PermissionCode> = {
  mounted(el, binding) {
    if (!binding.value) return;
    const auth = useAuthStore();
    if (!auth.has(binding.value)) el.remove();
  },
};
