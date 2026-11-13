#!/usr/bin/env bash
set -euo pipefail
verification_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$verification_dir/prepare.py"
mysql_image=${MYSQL_IMAGE:-mysql:8.0.46}
mysql_container=''
cleanup(){ if [[ -n "$mysql_container" ]]; then docker rm -f "$mysql_container" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
mysql_container="$(docker run --rm -d --tmpfs /var/lib/mysql \
    -e MYSQL_ROOT_PASSWORD=review-only -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=lab09 \
    "$mysql_image" --default-time-zone=+00:00 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci)"
ready=false
for ((attempt=0; attempt<60; attempt++)); do
    if docker exec -e MYSQL_PWD=review-only "$mysql_container" mysql -h127.0.0.1 -uroot -e 'SELECT 1' >/dev/null 2>&1; then ready=true;break;fi
    sleep 1
done
[[ "$ready" == true ]] || { docker logs "$mysql_container" >&2;exit 1; }
docker exec -e MYSQL_PWD=review-only "$mysql_container" mysql -uroot -N -B -e 'SELECT VERSION(),@@transaction_isolation,@@time_zone'
maven_options=(-B)
if [[ -n "${MAVEN_CACHE_DIR:-}" ]]; then
    maven_mount="$MAVEN_CACHE_DIR:/m2:ro";maven_options+=(-o)
else
    mkdir -p "$verification_dir/target/m2";maven_mount="$verification_dir/target/m2:/m2"
fi
mysql_test_url='jdbc:mysql://127.0.0.1:3306/lab09?sslMode=DISABLED&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true'
docker run --rm --network "container:$mysql_container" \
    -e "MYSQL_TEST_URL=$mysql_test_url" \
    -v "$verification_dir:/work" -v "$maven_mount" -w /work \
    maven:3.9-eclipse-temurin-21 mvn "${maven_options[@]}" -Dmaven.repo.local=/m2 test
