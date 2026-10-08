import { closeDb } from './connection';
import { runMigrations } from './migrate';

const { applied, skipped } = runMigrations();

if (applied.length > 0) {
  console.log(`已应用迁移：${applied.join(', ')}`);
}
if (skipped.length > 0) {
  console.log(`已跳过（已应用）：${skipped.join(', ')}`);
}
if (applied.length === 0 && skipped.length === 0) {
  console.log('未找到迁移文件');
}

closeDb();