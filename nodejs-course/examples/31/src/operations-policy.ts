export function validateDrillPlan(value: unknown): { dumpFile: string; restoreDatabase: string; createdAt: string } {
  if (!value || typeof value !== 'object') throw new Error('drill plan required');
  const input = value as Record<string, unknown>;
  if (typeof input.dumpFile !== 'string' || !/^backup_[0-9a-f]{32}\.dump$/.test(input.dumpFile) ||
      typeof input.restoreDatabase !== 'string' || !/^restore_[0-9a-f]{12}$/.test(input.restoreDatabase) ||
      typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) throw new Error('drill plan invalid');
  return { dumpFile: input.dumpFile, restoreDatabase: input.restoreDatabase, createdAt: input.createdAt };
}
export function restoreUrl(source: string, plan: unknown) {
  const target = validateDrillPlan(plan); const url = new URL(source);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' || url.pathname !== '/course') throw new Error('unexpected source database');
  url.hostname = 'restore-db'; url.pathname = '/' + target.restoreDatabase;
  return url.toString();
}

export function verifyBackupManifest(plan: unknown, manifest: unknown, digest: { sha256: string; bytes: number }): void {
  const expected = validateDrillPlan(plan);
  if (!manifest || typeof manifest !== 'object') throw new Error('backup manifest required');
  const saved = manifest as Record<string, unknown>;
  if (saved.dumpFile !== expected.dumpFile || saved.restoreDatabase !== expected.restoreDatabase || saved.planCreatedAt !== expected.createdAt ||
      typeof saved.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(saved.sha256) || saved.sha256 !== digest.sha256 ||
      !Number.isSafeInteger(saved.bytes) || saved.bytes !== digest.bytes || digest.bytes <= 0) throw new Error('backup integrity mismatch');
}
