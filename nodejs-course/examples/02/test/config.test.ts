import { describe, expect, test } from '@jest/globals';
import { ConfigError, loadConfig } from '../src/config.js';

const valid = { APP_NAME: 'article-course', PORT: '3000' };

describe('啟動設定', () => {
  test('轉成有型別的設定，缺少選填值時使用預設', () => {
    expect(loadConfig({ ...valid, APP_NAME: ' article-course ' })).toEqual({
      appName: 'article-course', port: 3000, environment: 'development', enableAuditLog: false,
    });
  });

  test.each(['APP_NAME', 'PORT'])('缺少必要欄位 %s 時失敗', (field) => {
    expect(() => loadConfig({ ...valid, [field]: undefined })).toThrow(field);
  });

  test.each(['', '   '])('APP_NAME 為 %j 時失敗', (value) => {
    expect(() => loadConfig({ ...valid, APP_NAME: value })).toThrow('APP_NAME');
  });

  test.each(['1', '65535'])('接受連接埠邊界 %s', (value) => {
    expect(loadConfig({ ...valid, PORT: value }).port).toBe(Number(value));
  });

  test.each(['', ' ', '0', '65536', '3.5', '3000abc', '1e3', '-1', 'NaN'])('拒絕非法 PORT %j', (value) => {
    expect(() => loadConfig({ ...valid, PORT: value })).toThrow('PORT');
  });

  test.each(['development', 'test', 'production'])('接受模式 %s', (value) => {
    expect(loadConfig({ ...valid, NODE_ENV: value }).environment).toBe(value);
  });

  test.each(['', 'staging'])('拒絕未定義的模式 %j', (value) => {
    expect(() => loadConfig({ ...valid, NODE_ENV: value })).toThrow('NODE_ENV');
  });

  test.each([['true', true], ['false', false]] as const)('把 %s 轉成布林值', (value, expected) => {
    expect(loadConfig({ ...valid, ENABLE_AUDIT_LOG: value }).enableAuditLog).toBe(expected);
  });

  test.each(['', '0', 'yes'])('拒絕模糊的布林設定 %j', (value) => {
    expect(() => loadConfig({ ...valid, ENABLE_AUDIT_LOG: value })).toThrow('ENABLE_AUDIT_LOG');
  });

  test('一次指出缺漏欄位，並使用可辨識的錯誤型別', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/APP_NAME.*PORT/);
  });

  test('不在錯誤訊息回顯輸入值', () => {
    const marker = 'private-value-placeholder';
    let caught: unknown;
    try { loadConfig({ ...valid, PORT: marker }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).not.toContain(marker);
  });

  test('不修改傳入資料，回傳可供各模組共用的凍結設定', () => {
    const input = Object.freeze({ ...valid });
    const config = loadConfig(input);
    expect(input).toEqual(valid);
    expect(Object.isFrozen(config)).toBe(true);
  });
});
