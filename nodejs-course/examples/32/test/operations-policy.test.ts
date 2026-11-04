import { expect, test } from '@jest/globals';
import { restoreUrl, validateDrillPlan, verifyBackupManifest } from '../src/operations-policy.js';
const plan = { dumpFile: 'backup_' + 'a'.repeat(32) + '.dump', restoreDatabase: 'restore_' + 'b'.repeat(12), createdAt: '2026-11-03T00:00:00Z' };
test('restore 總是使用隔離 host／唯一資料庫，保留原來源不變', () => {
  const source = 'postgresql://course:password@postgres:5432/course?schema=public';
  const target = new URL(restoreUrl(source, plan)); expect(target.hostname).toBe('restore-db'); expect(target.pathname).toBe('/' + plan.restoreDatabase); expect(new URL(source).hostname).toBe('postgres');
});
test.each([
  { ...plan, dumpFile: '../source.dump' }, { ...plan, dumpFile: 'backup_' + 'x'.repeat(32) + '.dump' },
  { ...plan, restoreDatabase: 'course' }, { ...plan, restoreDatabase: 'postgres' },
  { ...plan, restoreDatabase: 'restore_123;DROP' }, { ...plan, createdAt: 'invalid' }, null,
])('拒絕路徑穿越、來源 DB 或非法計畫 %j', value => expect(() => validateDrillPlan(value)).toThrow());
test.each(['postgresql://course:p@elsewhere:5432/course', 'postgresql://course:p@postgres:5432/other', 'http://postgres/course'])('未知來源拒絕 %s', source => expect(() => restoreUrl(source, plan)).toThrow());

const digest = { sha256: 'c'.repeat(64), bytes: 128 };
const manifest = { dumpFile: plan.dumpFile, restoreDatabase: plan.restoreDatabase, planCreatedAt: plan.createdAt, ...digest };
test('備份 manifest 綁定原計畫、SHA-256 與 byte count', () => expect(() => verifyBackupManifest(plan, manifest, digest)).not.toThrow());
test.each([null, { ...manifest, dumpFile: 'backup_'+'d'.repeat(32)+'.dump' }, { ...manifest, restoreDatabase: 'restore_'+'d'.repeat(12) },
  { ...manifest, planCreatedAt: '2020-01-01T00:00:00Z' }, { ...manifest, sha256: 'd'.repeat(64) }, { ...manifest, bytes: 127 },
])('拒絕舊計畫或已改變的備份 manifest %j', value => expect(() => verifyBackupManifest(plan, value, digest)).toThrow());
