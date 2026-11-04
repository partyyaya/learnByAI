#!/bin/sh
set -eu
docker compose -f compose.production.yaml run --rm --no-deps --entrypoint node api -e '
  const assert = require("node:assert/strict"); const fs = require("node:fs");
  assert.notEqual(process.getuid(), 0);
  for (const name of ["src", "prisma", "scripts", "node_modules/jest", "node_modules/typescript", "node_modules/prisma", "dist/seed-database.js", "dist/performance-lab.js"]) assert.equal(fs.existsSync(name), false, name);
  assert.ok(fs.existsSync("dist/main.js")); assert.ok(fs.existsSync(".data/articles.ndjson"));
  assert.throws(() => fs.writeFileSync("/app/write-probe", "denied"));
  console.log(JSON.stringify({event:"runtime_image_verified",releaseId:JSON.parse(fs.readFileSync("release.json")).releaseId}));
'
container=$(docker compose -f compose.production.yaml ps -q api)
docker inspect --format '{{json .}}' "$container" | docker compose run --rm -T tools node scripts/validate-container.cjs
# Production HTTP origins must fail before listening.
if docker compose -f compose.production.yaml run --rm --no-deps -e APP_ORIGIN=http://localhost:34430 api > .data/invalid-production.log 2>&1; then
  echo 'FAIL: production accepted HTTP origin' >&2
  exit 1
fi
echo 'PASS invalid production configuration exits nonzero'
