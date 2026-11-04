const { mkdirSync, existsSync, mkdtempSync, writeFileSync, chmodSync, renameSync, rmSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const directory = 'deploy/local';
try {
  if (existsSync(directory)) {
    for (const name of ['postgres_password', 'database_url', 'ca.crt', 'tls.crt', 'tls.key', 'pgpass']) if (!existsSync(join(directory, name))) throw new Error('incomplete local material');
    console.log('DEPLOY_MATERIAL_REUSED: existing credentials and certificates preserved');
  } else {
    mkdirSync('deploy', { recursive: true }); const temp = mkdtempSync('deploy/.init-'); chmodSync(temp, 0o700);
    try {
      const password = randomBytes(32).toString('hex');
      writeFileSync(join(temp, 'postgres_password'), password + '\n');
      writeFileSync(join(temp, 'pgpass'), `postgres:5432:course:course:${password}\nrestore-db:5432:*:course:${password}\n`, { mode: 0o600 });
      writeFileSync(join(temp, 'database_url'), `postgresql://course:${password}@postgres:5432/course?schema=public\n`);
      const run = args => execFileSync('openssl', args, { stdio: 'pipe' });
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', join(temp, 'ca.key'), '-out', join(temp, 'ca.crt'), '-subj', '/CN=Node Course Local CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
      run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'tls.key'), '-out', join(temp, 'tls.csr'), '-subj', '/CN=localhost']);
      writeFileSync(join(temp, 'tls.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
      run(['x509', '-req', '-in', join(temp, 'tls.csr'), '-CA', join(temp, 'ca.crt'), '-CAkey', join(temp, 'ca.key'), '-CAcreateserial', '-out', join(temp, 'tls.crt'), '-days', '7', '-extfile', join(temp, 'tls.ext')]);
      for (const name of ['postgres_password', 'database_url', 'ca.crt', 'tls.crt', 'tls.key']) chmodSync(join(temp, name), 0o444);
      chmodSync(join(temp, 'ca.key'), 0o600);
      renameSync(temp, directory); console.log('DEPLOY_MATERIAL_CREATED: local-only CA and credentials; no trust-store changes');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
} catch { console.error('DEPLOY_INIT_FAILED: preserve existing files; inspect local material before recovery'); process.exitCode = 1; }
