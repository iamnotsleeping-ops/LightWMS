import { closeDb } from './connection';
import { seedDemoData } from './seed';

const args = process.argv.slice(2);
const reset =
  args.includes('--reset') || args.includes('--force') || process.env.SEED_RESET === '1';

const result = seedDemoData({ reset });

if (result.skipped) {
  console.log('演示数据已存在，跳过（使用 pnpm seed --reset 重建）');
} else {
  console.log(reset ? '已清空业务数据并重建演示数据' : '已灌入演示数据');
  console.log('各表行数：');
  for (const [table, count] of Object.entries(result.counts)) {
    console.log(`  ${table}: ${count}`);
  }
}

closeDb();