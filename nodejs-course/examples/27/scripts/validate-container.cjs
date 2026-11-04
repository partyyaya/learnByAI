const assert = require('node:assert/strict');
const fs = require('node:fs');
const object = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.equal(object.Config.User, 'node');
assert.equal(object.HostConfig.ReadonlyRootfs, true);
assert.equal(object.HostConfig.Memory, 512 * 1024 * 1024);
assert.equal(object.HostConfig.NanoCpus, 1000000000);
assert.equal(object.HostConfig.PidsLimit, 64);
assert.ok(object.HostConfig.CapDrop.includes('ALL'));
assert.ok(object.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
assert.equal(Object.keys(object.HostConfig.PortBindings ?? {}).length, 0);
assert.ok(!object.Config.Env.some(value => value.startsWith('DATABASE_URL=')));
for (const mount of object.Mounts) if (mount.Type === 'bind') assert.equal(mount.Destination, '/run/secrets/database_url');
fs.mkdirSync('.data', { recursive: true });
fs.writeFileSync('.data/runtime-proof.json', JSON.stringify({ imageId: object.Image,
  releaseId: object.Config.Labels['org.opencontainers.image.revision'], user: object.Config.User,
  rootReadOnly: true, memoryBytes: object.HostConfig.Memory, nanoCpus: object.HostConfig.NanoCpus, pidsLimit: object.HostConfig.PidsLimit, publishedPorts: 0 }, null, 2) + '\n');
console.log('PASS running API: non-root, read-only, constrained resources, no published port or source mount');
