#!/bin/sh
set -eu
cleanup() {
  result=$?
  trap - EXIT
  docker compose -f compose.production.yaml stop proxy api postgres restore-db >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
export RELEASE_ID=chapter30-r1
docker compose -f compose.production.yaml build api migrate verifier
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
container=$(docker compose -f compose.production.yaml ps -q api)
image_r1=$(docker inspect --format '{{.Image}}' "$container")
export RELEASE_ID=chapter30-r2
docker compose -f compose.production.yaml build api migrate
docker compose -f compose.production.yaml run --rm migrate
docker compose -f compose.production.yaml up -d --wait --no-deps --no-build api
docker compose -f compose.production.yaml run --rm verifier --verify
container=$(docker compose -f compose.production.yaml ps -q api)
image_r2=$(docker inspect --format '{{.Image}}' "$container")
export RELEASE_ID=chapter30-r1
docker compose -f compose.production.yaml up -d --wait --no-deps --no-build api
docker compose -f compose.production.yaml run --rm verifier --verify
sh scripts/check-runtime.sh
container=$(docker compose -f compose.production.yaml ps -q api)
image_returned=$(docker inspect --format '{{.Image}}' "$container")
docker compose run --rm tools node -e '
  const assert=require("node:assert/strict"); const fs=require("node:fs");
  const [r1,r2,returned]=process.argv.slice(1);
  for(const value of [r1,r2,returned]) assert.match(value,/^sha256:[0-9a-f]{64}$/);
  assert.notEqual(r1,r2); assert.equal(r1,returned);
  fs.writeFileSync(".data/rollback-proof.json",JSON.stringify({sequence:["chapter30-r1","chapter30-r2","chapter30-r1"],imageIds:[r1,r2,returned],articleCommentSessionPreserved:true,metadataOnly:true},null,2)+"\n");
  console.log("PASS image switch: r1 -> r2 -> original r1; article, comment and Session preserved; metadata-only rehearsal");
' "$image_r1" "$image_r2" "$image_returned"
