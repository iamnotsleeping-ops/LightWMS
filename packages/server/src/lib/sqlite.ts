import { ApiError } from './response';

/** 把 SQLite 约束冲突翻译成可读的业务错误，其余错误原样抛出 */
export function rethrowConstraint(error: unknown, uniqueMessage: string): never {
  const code = (error as { code?: string }).code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    throw new ApiError(409, uniqueMessage);
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    throw new ApiError(409, '该记录已被其他数据引用，无法删除；如需停用请改为「停用」');
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK') {
    throw new ApiError(409, '数据不满足业务约束');
  }
  throw error;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 由「列名 → 值」构造 UPDATE 的 SET 片段，值为 undefined 的列跳过 */
export function buildSet(entries: [string, unknown][]): { clause: string; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of entries) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  return { clause: sets.join(', '), params };
}