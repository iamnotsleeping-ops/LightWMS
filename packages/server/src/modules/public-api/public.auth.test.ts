import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { createTestDb } from '../../test/db';

/**
 * 对外只读接口的 API Key 鉴权。
 *
 * 为什么要这一层：`/api/v1` 暴露库存、采购单价、供应商提前期、销售订单行与客户认证等
 * **商业数据**，无鉴权等于公网裸奔。这里把「所有数据接口都必须要求 Key」钉死——
 * 将来有人新增一个 `/api/v1/*` 接口却忘了被守卫覆盖，本文件会立刻失败。
 *
 * 例外（有意为之）：`/api/v1/openapi.json` 是契约文档、不含业务数据，保持公开。
 */
const KEY = 'k'.repeat(32);

/** 全部**数据**接口（新增接口必须同步加进来，否则守卫漏覆盖不会被发现） */
const DATA_URLS = [
  '/api/v1/items',
  '/api/v1/boms',
  '/api/v1/boms/FG-001/explode',
  '/api/v1/inventory',
  '/api/v1/in-transit',
  '/api/v1/purchase-history',
  '/api/v1/suppliers/SU-01/lead-time-stats',
  '/api/v1/sales-orders',
  '/api/v1/item-certifications',
  '/api/v1/warehouses',
  '/api/v1/substitutes?main_item_code=RM-001',
  '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=1',
];

describe('对外只读接口 · API Key 鉴权', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    createTestDb();
    app = await buildApp({ publicApiKey: KEY });
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (url: string, key?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: key === undefined ? {} : { 'x-api-key': key },
    });

  it('所有数据接口缺 Key → 401，且返回统一信封而非裸错误', async () => {
    for (const url of DATA_URLS) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(401);
      const body = res.json();
      expect(body.code, url).toBe(401);
      expect(body.data, url).toBeNull();
      expect(body.message, url).toContain('X-API-Key');
    }
  });

  it('Key 错误 → 401；Key 正确 → 200（放行到业务逻辑）', async () => {
    const wrong = await get('/api/v1/items', 'x'.repeat(32));
    expect(wrong.statusCode).toBe(401);

    // 长度不同也不能通过（timingSafeEqual 要求等长，先比长度再比内容）
    const short = await get('/api/v1/items', 'short');
    expect(short.statusCode).toBe(401);

    const okRes = await get('/api/v1/items', KEY);
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().code).toBe(0);
  });

  it('CSV 导出同样受 Key 保护（不能绕过 JSON 通道拿数据）', async () => {
    const noKey = await get('/api/v1/items?format=csv');
    expect(noKey.statusCode).toBe(401);
    const withKey = await get('/api/v1/items?format=csv', KEY);
    expect(withKey.statusCode).toBe(200);
    expect(withKey.headers['content-type']).toContain('text/csv');
  });

  it('openapi.json 不要求 Key（契约文档公开，内部数据接口页也从它渲染）', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      security?: unknown;
      components?: { securitySchemes?: Record<string, { type: string; in: string; name: string }> };
      paths: Record<string, { get: { responses: Record<string, unknown> } }>;
    };
    // 声明了 apiKey 方案，且每个操作都写了 401 响应
    const scheme = doc.components?.securitySchemes?.ApiKeyAuth;
    expect(scheme).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    expect(doc.security).toEqual([{ ApiKeyAuth: [] }]);
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBe(DATA_URLS.length);
    for (const path of paths) {
      expect(doc.paths[path].get.responses['401'], `${path} 缺 401 响应`).toBeTruthy();
    }
  });

  it('未配置 Key（非生产默认）时不拦截：本地开发与既有测试保持公开', async () => {
    const publicApp = await buildApp({ publicApiKey: '' });
    try {
      const res = await publicApp.inject({ method: 'GET', url: '/api/v1/items' });
      expect(res.statusCode).toBe(200);
    } finally {
      await publicApp.close();
    }
  });
});
