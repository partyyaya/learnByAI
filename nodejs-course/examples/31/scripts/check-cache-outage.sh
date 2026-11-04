#!/bin/sh
set -eu
# Only this chapter's optional cache is stopped; PostgreSQL/Session remain authoritative.
docker compose -f compose.production.yaml run --rm verifier --verify
docker compose -f compose.production.yaml stop cache-redis
docker compose -f compose.production.yaml run --rm verifier --verify
docker compose -f compose.production.yaml up -d --wait cache-redis
docker compose -f compose.production.yaml run --rm verifier --verify
docker compose run --rm tools node -e 'require("node:fs").writeFileSync(".data/cache-outage-proof.json",JSON.stringify({redisStopped:true,postgresSessionAndArticleAvailable:true,cacheRestarted:true})+"\n");console.log("PASS cache outage: real Redis stop/restart preserves HTTPS article and Session")'
