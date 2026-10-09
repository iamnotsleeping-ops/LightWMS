import { ElMessageBox } from 'element-plus';

export interface ConfirmOptions {
  type?: 'warning' | 'info' | 'error' | 'success';
  confirmButtonText?: string;
  cancelButtonText?: string;
}

/**
 * 带「取消即返回」语义的确认框。
 *
 * 为什么需要它：`ElMessageBox.confirm` 在用户点「取消」或右上角关闭时会 **reject**
 * （抛出 `'cancel'` / `'close'`）。直接 `await` 而不捕获，就会产生未处理的 Promise 拒绝，
 * 控制台报错、且后续逻辑被跳过的方式不明确。之前仓库里两种写法混用：少数页面用
 * `try { await confirm } catch { return }`，多数页面直接 `await`。
 *
 * 统一入口后，调用方只需：
 *
 * ```ts
 * if (!(await confirmAction('确认删除？', '删除确认'))) return;
 * ```
 *
 * 确认返回 `true`，取消 / 关闭返回 `false`（不抛错）。
 */
export async function confirmAction(
  message: string,
  title: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      type: options.type ?? 'warning',
      confirmButtonText: options.confirmButtonText ?? '确定',
      cancelButtonText: options.cancelButtonText ?? '取消',
    });
    return true;
  } catch {
    return false;
  }
}
