const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
(async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'course29-integrity-')); await fs.chmod(directory, 0o700);
  try {
    const plan = { dumpFile: 'backup_'+'a'.repeat(32)+'.dump', restoreDatabase: 'restore_'+'a'.repeat(12), createdAt: new Date().toISOString() };
    const bytes = Buffer.from('owned synthetic archive fixture');
    const manifest = { dumpFile: plan.dumpFile, restoreDatabase: plan.restoreDatabase, planCreatedAt: plan.createdAt, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await fs.mkdir(join(directory, '.data/backups'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(directory, '.data/drill-plan.json'), JSON.stringify(plan));
    await fs.writeFile(join(directory, '.data/backup-manifest.json'), JSON.stringify(manifest));
    const archive = join(directory, '.data/backups', plan.dumpFile); await fs.writeFile(archive, bytes);
    const args = [resolve('scripts/prepare-drill.cjs'), '--verify-backup'];
    const options = { cwd: directory, timeout: 5000, maxBuffer: 4096 };
    const valid = await execute(process.execPath, args, options); assert.match(valid.stdout, /PASS backup integrity/);
    bytes[0] ^= 1; await fs.writeFile(archive, bytes); // Same length, different contents.
    await assert.rejects(execute(process.execPath, [resolve('scripts/prepare-drill.cjs'), '--record-backup'], options), error => error.code === 1 && error.stderr.trim() === 'OPERATIONS_EVIDENCE_FAILED');
    await assert.rejects(execute(process.execPath, args, options), error => error.code === 1 && error.stderr.trim() === 'OPERATIONS_EVIDENCE_FAILED');
    console.log('PASS backup corruption: same-length archive change rejected before restore; owned fixture cleaned');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
})().catch(() => { console.error('BACKUP_INTEGRITY_CHECK_FAILED'); process.exitCode = 1; });
