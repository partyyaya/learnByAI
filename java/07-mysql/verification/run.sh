#!/usr/bin/env bash
set -euo pipefail
verification_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MYSQL_IMAGE=${MYSQL_IMAGE:-mysql:8.0.46}
export MYSQL_IMAGE
python3 "$verification_dir/prepare.py"
primary_container=''
replica_container=''
cleanup() {
    if [[ -n "$replica_container" ]]; then docker rm -f "$replica_container" >/dev/null 2>&1 || true; fi
    if [[ -n "$primary_container" ]]; then docker rm -f "$primary_container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
primary_container="$(docker run --rm -d --tmpfs /var/lib/mysql \
    -e MYSQL_ROOT_PASSWORD=review-only -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=shop \
    "$MYSQL_IMAGE" --server-id=71 --log-bin=binlog --gtid-mode=ON \
    --enforce-gtid-consistency=ON --default-time-zone=+00:00)"
replica_container="$(docker run --rm -d --network "container:$primary_container" --tmpfs /var/lib/mysql \
    -e MYSQL_ROOT_PASSWORD=review-only -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=shop \
    "$MYSQL_IMAGE" --port=3307 --server-id=72 --log-bin=binlog --gtid-mode=ON \
    --enforce-gtid-consistency=ON --replica-parallel-workers=0 --default-time-zone=+00:00)"
ready() {
    local container="$1" port="$2" attempt
    for ((attempt=0; attempt<60; attempt++)); do
        if docker exec -e MYSQL_PWD=review-only "$container" mysql -h127.0.0.1 -P"$port" -uroot \
                -e 'SELECT 1' >/dev/null 2>&1; then return; fi
        sleep 1
    done
    docker logs "$container" >&2
    return 1
}
ready "$primary_container" 3306
ready "$replica_container" 3307
# Both fixtures start with an empty shop. Mark the source's bootstrap GTIDs as seeded;
# this is fixture setup, not a production replica provisioning recipe.
docker exec -e MYSQL_PWD=review-only "$primary_container" mysql -uroot -e \
    "CREATE USER 'verify_repl'@'%' IDENTIFIED BY 'replication-only'; GRANT REPLICATION SLAVE ON *.* TO 'verify_repl'@'%';"
source_gtids="$(docker exec -e MYSQL_PWD=review-only "$primary_container" mysql -uroot -N -B -e 'SELECT @@GLOBAL.gtid_executed')"
docker exec -e MYSQL_PWD=review-only "$replica_container" mysql -uroot -e \
    "SET GLOBAL gtid_purged='+$source_gtids';
     CHANGE REPLICATION FILTER REPLICATE_WILD_DO_TABLE=('shop.%');
     CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1', SOURCE_PORT=3306,
       SOURCE_USER='verify_repl',SOURCE_PASSWORD='replication-only',SOURCE_AUTO_POSITION=1,GET_SOURCE_PUBLIC_KEY=1;
     START REPLICA; SET GLOBAL super_read_only=ON;"
export VERIFY_PRIMARY_CONTAINER="$primary_container" VERIFY_REPLICA_CONTAINER="$replica_container"
export MYSQL_PRIMARY_URL='jdbc:mysql://127.0.0.1:3306/shop?sslMode=DISABLED&allowPublicKeyRetrieval=true&characterEncoding=UTF-8&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&useServerPrepStmts=true&rewriteBatchedStatements=true'
export MYSQL_REPLICA_URL='jdbc:mysql://127.0.0.1:3307/shop?sslMode=DISABLED&allowPublicKeyRetrieval=true&characterEncoding=UTF-8&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true'
maven_options=(-B)
if [[ -n "${MAVEN_CACHE_DIR:-}" ]]; then
    maven_mount="$MAVEN_CACHE_DIR:/m2:ro"
    maven_options+=(-o)
else
    mkdir -p "$verification_dir/target/m2"
    maven_mount="$verification_dir/target/m2:/m2"
fi
docker run --rm --network "container:$primary_container" \
    -e MYSQL_PRIMARY_URL -e MYSQL_REPLICA_URL \
    -v "$verification_dir:/work" -v "$maven_mount" -w /work \
    maven:3.9-eclipse-temurin-21 mvn "${maven_options[@]}" -Dmaven.repo.local=/m2 test
python3 "$verification_dir/test_shell.py"
