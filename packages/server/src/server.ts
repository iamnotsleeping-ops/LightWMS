import { buildApp } from './app';
import { assertStartupConfig, config } from './config/index';
import { closeDb, getDb } from './db/connection';
import { runMigrations } from './db/migrate';

async function main(): Promise<void> {
  // 生产环境下「mock 登录 / 默认 JWT 密钥 / 钉钉必填项缺失」直接拒绝启动
  const configProblems = assertStartupConfig();
  if (configProblems.length > 0) {
    console.error('配置自检未通过，已拒绝启动：');
    for (const problem of configProblems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  getDb();
  const { applied } = runMigrations();
  if (applied.length > 0) {
    console.log(`数据库迁移完成：${applied.join(', ')}`);
  }

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在关闭`);
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});