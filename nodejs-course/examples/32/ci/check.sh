#!/bin/sh
set -eu
# Run from examples/32. No registry credentials, cloud deployment or Git mutation.
cleanup() {
  result=$?
  trap - EXIT
  docker compose -f compose.production.yaml stop worker dispatcher job-redis cache-redis proxy api postgres restore-db >/dev/null 2>&1 || true
  docker compose stop worker dispatcher job-redis cache-redis api cors-lab external-lab upstream performance-lab postgres test-db >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
export RELEASE_ID=${RELEASE_ID:-local-ci}
docker compose build tools
docker compose up -d --wait test-db cache-redis job-redis
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose build browser-tests
docker compose run --rm browser-tests npm run test:browser
docker compose run --rm tools npm run deploy:init
docker compose -f compose.production.yaml build api migrate verifier worker dispatcher
sh scripts/deploy-local.sh
sh scripts/check-runtime.sh
sh scripts/check-cache-outage.sh
docker compose -f compose.production.yaml restart postgres
docker compose -f compose.production.yaml up -d --wait postgres
docker compose -f compose.production.yaml restart api
docker compose -f compose.production.yaml run --rm verifier --verify

sh scripts/failure-drills.sh
