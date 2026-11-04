#!/bin/sh
set -eu
# Only this chapter's production project and a separate restore target are touched.
docker compose -f compose.production.yaml run --rm verifier
docker compose -f compose.production.yaml stop postgres
docker compose -f compose.production.yaml run --rm verifier --db-unavailable
docker compose -f compose.production.yaml up -d --wait postgres
docker compose -f compose.production.yaml run --rm verifier --verify
# Quiesce this local single-writer rehearsal so pre-dump counts match its snapshot.
docker compose -f compose.production.yaml stop proxy api worker dispatcher
docker compose run --rm tools node scripts/prepare-drill.cjs
dump_file=$(docker compose run --rm -T tools node -p 'JSON.parse(require("node:fs").readFileSync(".data/drill-plan.json")).dumpFile')
restore_db=$(docker compose run --rm -T tools node -p 'JSON.parse(require("node:fs").readFileSync(".data/drill-plan.json")).restoreDatabase')
docker compose -f compose.production.yaml run --rm --no-deps restore-verifier snapshot
# Two identical names race; exactly one atomic output reservation must succeed.
docker compose -f compose.production.yaml run --rm -e DUMP_FILE="$dump_file" backup backup > .data/backup-first.log 2>&1 &
first=$!
docker compose -f compose.production.yaml run --rm -e DUMP_FILE="$dump_file" backup backup > .data/backup-second.log 2>&1 &
second=$!
first_result=0; wait "$first" || first_result=$?
second_result=0; wait "$second" || second_result=$?
case "$first_result:$second_result" in 0:1|0:2|1:0|2:0) ;; *) echo 'FAIL concurrent backup reservation' >&2; exit 1;; esac
echo 'PASS atomic backup: exactly one concurrent writer accepted'
docker compose run --rm tools node scripts/prepare-drill.cjs --record-backup
docker compose -f compose.production.yaml up -d --wait api worker dispatcher proxy
docker compose -f compose.production.yaml run --rm verifier --verify --record-recovery
docker compose -f compose.production.yaml up -d --wait restore-db
docker compose run --rm tools node scripts/prepare-drill.cjs --verify-backup
docker compose -f compose.production.yaml run --rm -e DUMP_FILE="$dump_file" -e RESTORE_DATABASE="$restore_db" backup restore
docker compose -f compose.production.yaml run --rm restore-verifier restore
# Refuse an existing dump and existing target, with original source untouched.
if docker compose -f compose.production.yaml run --rm -e DUMP_FILE="$dump_file" backup backup > .data/backup-overwrite-denied.log 2>&1; then
  echo 'FAIL existing dump accepted' >&2; exit 1
fi
if docker compose -f compose.production.yaml run --rm -e DUMP_FILE="$dump_file" -e RESTORE_DATABASE="$restore_db" backup restore > .data/restore-overwrite-denied.log 2>&1; then
  echo 'FAIL existing restore target accepted' >&2; exit 1
fi
if docker compose -f compose.production.yaml run --rm -e DUMP_FILE=backup_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.dump backup backup > .data/invalid-backup-denied.log 2>&1; then
  echo 'FAIL invalid backup accepted' >&2; exit 1
fi
echo 'PASS backup guards: existing dump/target and invalid hex names refused'
docker compose run --rm tools node scripts/prepare-drill.cjs --finish
