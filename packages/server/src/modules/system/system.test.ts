import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { createTestDb } from '../../test/db';

/** 系统参数只读接口：/api/system/params */
let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = createTestDb();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

const tokenWith = (permissions: string[]) =>
  app.jwt.sign({ sub: 1, name: 'tester', roles: ['sys_admin'], permissions });

describe('系统参数（只读）', () => {
  it('有 system.param.view 权限时返回参数清单', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/params',
      headers: { authorization: `Bearer ${tokenWith(['system.param.view'])}` },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.code).toBe(0);
    const keys = (payload.data as { key: string }[]).map((row) => row.key);
    expect(keys).toContain('port_stock_as_inventory');
  });

  it('缺少权限时返回 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/params',
      headers: { authorization: `Bearer ${tokenWith([])}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe(403);
  });

  it('未登录时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/params' });
    expect(response.statusCode).toBe(401);
  });

  it('接口只读：调用不改变 sys_param 内容', async () => {
    const before = db.prepare('SELECT key, value FROM sys_param ORDER BY key').all();
    await app.inject({
      method: 'GET',
      url: '/api/system/params',
      headers: { authorization: `Bearer ${tokenWith(['system.param.view'])}` },
    });
    const after = db.prepare('SELECT key, value FROM sys_param ORDER BY key').all();
    expect(after).toEqual(before);
  });
});
