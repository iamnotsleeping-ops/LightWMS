import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  businessDateOf,
  businessDateRange,
  businessDayEnd,
  businessDayStart,
  businessToday,
} from './time';

/**
 * 业务时区（UTC+8）换算。
 *
 * 这些等式是整个「日期口径」的地基：`occurred_at` 以 UTC ISO 落库，
 * 而 `dateFrom/dateTo/as_of` 是人给的业务日期，换算错一小时就会让本地凌晨的流水
 * 落到前一天。这里把边界值钉死，避免以后有人再改回 UTC 取日。
 */

describe('业务日边界 → UTC 时间戳', () => {
  it('起点 = 本地 00:00:00.000，即 UTC 前一日 16:00:00.000Z', () => {
    expect(businessDayStart('2026-04-15')).toBe('2026-04-14T16:00:00.000Z');
  });

  it('终点 = 本地 23:59:59.999，即 UTC 当日 15:59:59.999Z', () => {
    expect(businessDayEnd('2026-04-15')).toBe('2026-04-15T15:59:59.999Z');
  });

  it('起止区间恰好覆盖 24 小时', () => {
    const span = Date.parse(businessDayEnd('2026-04-15')) - Date.parse(businessDayStart('2026-04-15'));
    expect(span).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('产出统一为 Z 形式，可与库中 occurred_at 直接做字符串比较', () => {
    for (const value of [businessDayStart('2026-01-01'), businessDayEnd('2026-12-31')]) {
      expect(value.endsWith('Z')).toBe(true);
      expect(value).not.toContain('+');
      // 字典序与时间序一致（跨年边界抽样）
      expect(businessDayStart('2026-01-01') < businessDayEnd('2026-12-31')).toBe(true);
    }
  });
});

describe('UTC 时间戳 → 所属业务日', () => {
  it('本地当日 23:59:59.999 仍属当日', () => {
    expect(businessDateOf('2026-04-15T15:59:59.999Z')).toBe('2026-04-15');
  });

  it('本地次日 00:00:00.000 起属次日（UTC 日期还是前一天）', () => {
    expect(businessDateOf('2026-04-15T16:00:00.000Z')).toBe('2026-04-16');
    expect(businessDateOf('2026-04-15T20:00:00.000Z')).toBe('2026-04-16');
  });

  it('本地前一日 23:00 属前一日（旧实现会误判为当日）', () => {
    expect(businessDateOf('2026-04-14T15:00:00.000Z')).toBe('2026-04-14');
  });

  it('与业务日起点自洽：任何时刻都落在其业务日区间内', () => {
    const instants = [
      '2026-04-14T16:00:00.000Z',
      '2026-04-15T00:00:00.000Z',
      '2026-04-15T15:59:59.999Z',
      '2026-12-31T16:00:00.000Z',
    ];
    for (const instant of instants) {
      const date = businessDateOf(instant);
      expect(Date.parse(instant)).toBeGreaterThanOrEqual(Date.parse(businessDayStart(date)));
      expect(Date.parse(instant)).toBeLessThanOrEqual(Date.parse(businessDayEnd(date)));
    }
  });
});

describe('业务日加减与区间', () => {
  it('加减天数可跨月跨年跨闰日', () => {
    expect(addBusinessDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addBusinessDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addBusinessDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('businessDateRange 生成升序连续区间且以指定日结尾', () => {
    const range = businessDateRange('2026-03-02', 3);
    expect(range).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('businessToday 形如 YYYY-MM-DD 且等于按 UTC+8 取日的当天', () => {
    const today = businessToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(businessDateOf(new Date().toISOString())).toBe(today);
  });
});
