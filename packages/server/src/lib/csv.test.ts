import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

/**
 * `lib/csv.ts` 的转义规则此前只有路由级间接覆盖（能证明 BOM / 列序 / 逗号加引号），
 * 含引号翻倍、换行、null、布尔、空集等分支从未被断言。这里逐条补齐。
 */

const BOM = '\uFEFF';

/** 去掉 BOM 与结尾 CRLF，按行切开 */
function linesOf(csv: string): string[] {
  return csv.replace(/^\uFEFF/, '').replace(/\r\n$/, '').split('\r\n');
}

describe('toCsv 基础结构', () => {
  it('空集只输出 BOM（不含表头与换行）', () => {
    expect(toCsv([])).toBe(BOM);
  });

  it('首行为列名，列序取自首行键序，行以 CRLF 分隔且结尾带 CRLF', () => {
    const csv = toCsv([
      { b: 1, a: 2 },
      { a: 4, b: 3 },
    ]);
    expect(csv).toBe(`${BOM}b,a\r\n1,2\r\n3,4\r\n`);
    expect(linesOf(csv)).toEqual(['b,a', '1,2', '3,4']);
  });

  it('列集合只由首行决定：后续行的额外键被忽略', () => {
    const csv = toCsv([{ a: 1 }, { a: 2, extra: 'x' }]);
    expect(linesOf(csv)).toEqual(['a', '1', '2']);
  });
});

describe('toCsv 单元格转义', () => {
  it('null 与 undefined → 空串', () => {
    expect(linesOf(toCsv([{ a: null, b: undefined, c: 'x' }]))).toEqual(['a,b,c', ',,x']);
  });

  it('布尔 → true / false（不是 1 / 0）', () => {
    expect(linesOf(toCsv([{ a: true, b: false }]))).toEqual(['a,b', 'true,false']);
  });

  it('数字 → 十进制文本', () => {
    expect(linesOf(toCsv([{ a: 0, b: -12, c: 3.5 }]))).toEqual(['a,b,c', '0,-12,3.5']);
  });

  it('对象 → JSON 字符串并加引号', () => {
    const csv = toCsv([{ a: { k: 1 } }]);
    expect(linesOf(csv)).toEqual(['a', '"{""k"":1}"']);
  });

  it('含逗号的单元格加引号', () => {
    expect(linesOf(toCsv([{ a: 'x,y' }]))).toEqual(['a', '"x,y"']);
  });

  it('含双引号的单元格加引号且引号翻倍（关键分支，此前无覆盖）', () => {
    expect(linesOf(toCsv([{ a: '说"引号"' }]))).toEqual(['a', '"说""引号"""']);
  });

  it('含 \\n 或 \\r 的单元格加引号以保持单行一行', () => {
    expect(linesOf(toCsv([{ a: 'l1\nl2', b: 'r1\rr2' }]))).toEqual([
      'a,b',
      '"l1\nl2","r1\rr2"',
    ]);
  });

  it('普通文本不加引号；空串保持空', () => {
    expect(linesOf(toCsv([{ a: 'plain', b: '' }]))).toEqual(['a,b', 'plain,']);
  });

  it('同时含逗号与引号时先加引号再翻倍', () => {
    expect(linesOf(toCsv([{ a: 'a,"b"' }]))).toEqual(['a', '"a,""b"""']);
  });
});
