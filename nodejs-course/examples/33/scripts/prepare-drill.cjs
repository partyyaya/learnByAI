const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const { validateDrillPlan, verifyBackupManifest } = require('../dist/operations-policy.js');
const read = name => JSON.parse(fs.readFileSync('.data/' + name));
async function archiveDigest(filename) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
(async () => {
  fs.mkdirSync('.data/backups', { recursive: true, mode: 0o700 }); fs.chmodSync('.data/backups', 0o700);
  const modes = ['--record-backup', '--verify-backup', '--finish'].filter(mode => process.argv.includes(mode));
  assert.ok(modes.length <= 1);
  assert.ok(process.argv.slice(2).every(mode => ['--record-backup', '--verify-backup', '--finish'].includes(mode)));
  if (!modes.length) {
    const id = randomUUID().replaceAll('-', '');
    fs.writeFileSync('.data/drill-plan.json', JSON.stringify(validateDrillPlan({ dumpFile: `backup_${id}.dump`, restoreDatabase: `restore_${id.slice(0,12)}`, createdAt: new Date().toISOString() }))+'\n');
    for (const name of ['backup-source.json', 'restore-proof.json', 'backup-manifest.json']) fs.writeFileSync('.data/' + name, '{}\n', { mode: 0o600 });
    return;
  }
  const plan = validateDrillPlan(read('drill-plan.json'));
  const digest = await archiveDigest('.data/backups/' + plan.dumpFile);
  if (modes[0] === '--record-backup') {
    assert.ok(digest.bytes > 0);
    const existing = read('backup-manifest.json');
    if (Object.keys(existing).length) { verifyBackupManifest(plan, existing, digest); console.log('PASS backup manifest: original digest preserved'); return; }
    fs.writeFileSync('.data/backup-manifest.json', JSON.stringify({ dumpFile: plan.dumpFile, restoreDatabase: plan.restoreDatabase, planCreatedAt: plan.createdAt, ...digest })+'\n');
    console.log('PASS backup manifest: recorded completed archive SHA-256 and size'); return;
  }
  verifyBackupManifest(plan, read('backup-manifest.json'), digest);
  if (modes[0] === '--verify-backup') { console.log('PASS backup integrity: archive matches its original manifest'); return; }
  const restored = read('restore-proof.json'); const source = read('backup-source.json');
  assert.equal(restored.database, plan.restoreDatabase);
  for (const key of ['articleRestored', 'commentRestored', 'sessionResolved', 'applicationReady', 'migrationHistoryMatched']) assert.equal(restored[key], true);
  assert.deepEqual(restored.counts, source.counts);
  assert.equal(restored.articleId, source.articleId); assert.equal(restored.commentId, source.commentId);
  const outage = read('database-outage-proof.json'); const recovery = read('source-recovery-proof.json');
  assert.equal(outage.ready, 503); assert.equal(outage.live, 200); assert.equal(outage.metrics, 200); assert.equal(outage.articles, 500); assert.equal(recovery.recovered, true);
  assert.ok(Date.parse(recovery.checkedAt) >= Date.parse(plan.createdAt));
  assert.equal(recovery.articleId, source.articleId); assert.equal(recovery.commentId, source.commentId);
  const proof = { checkedAt: new Date().toISOString(), dumpFile: plan.dumpFile, ...digest, backupIntegrityVerified: true,
    backupRestoreElapsedMs: Date.now() - Date.parse(plan.createdAt), databaseOutage: outage, sourceRecovery: recovery, restored };
  fs.writeFileSync('.data/operations-proof.json', JSON.stringify(proof, null, 2)+'\n');
  console.log('PASS operations evidence: original archive integrity, isolated restore, source recovery and counts; no SLO claim');
})().catch(() => { console.error('OPERATIONS_EVIDENCE_FAILED'); process.exitCode = 1; });
