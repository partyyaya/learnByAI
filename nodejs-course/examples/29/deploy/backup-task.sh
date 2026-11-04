#!/bin/sh
set -eu
umask 077
case ${DUMP_FILE:-} in backup_????????????????????????????????.dump) ;; *) echo 'invalid backup name' >&2; exit 1;; esac
# Names are also validated by the Node plan; all connection targets are fixed here.
dump_id=${DUMP_FILE#backup_}; dump_id=${dump_id%.dump}
case "$dump_id" in *[!0-9a-f]*) exit 1;; esac
if [ "${1:-}" = backup ]; then
  # noclobber atomically reserves the output; no check-then-open overwrite race.
  set -C
  pg_dump -h postgres -U course -d course --format=custom --no-owner --no-acl > "/backup/$DUMP_FILE"
elif [ "${1:-}" = restore ]; then
  case ${RESTORE_DATABASE:-} in restore_????????????) ;; *) exit 1;; esac
  target_id=${RESTORE_DATABASE#restore_}
  case "$target_id" in *[!0-9a-f]*) exit 1;; esac
  # Never --clean / --create against the source DB. Existing targets fail instead of overwriting.
  createdb -h restore-db -U course --maintenance-db=postgres "$RESTORE_DATABASE"
  pg_restore -h restore-db -U course --dbname="$RESTORE_DATABASE" --exit-on-error --single-transaction --no-owner --no-acl "/backup/$DUMP_FILE"
else
  exit 1
fi
