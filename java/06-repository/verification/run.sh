#!/usr/bin/env bash
set -euo pipefail
verification_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$verification_dir/prepare.py"
review_container="$(docker run --rm -d --tmpfs /var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=review-only -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=review mysql:8.0)"
cleanup() { docker rm -f "$review_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$review_container" mysqladmin ping -h 127.0.0.1 -uroot -preview-only --silent >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$review_container"
  exit 1
fi
maven_options=(-B)
if [[ -n "${MAVEN_CACHE_DIR:-}" ]]; then
  maven_mount="$MAVEN_CACHE_DIR:/m2:ro"
  maven_options+=(-o)
else
  mkdir -p "$verification_dir/target/m2"
  maven_mount="$verification_dir/target/m2:/m2"
fi
docker run --rm --network "container:$review_container" \
  -v "$verification_dir:/work" -v "$maven_mount" -w /work \
  maven:3.9-eclipse-temurin-21 \
  mvn "${maven_options[@]}" -Dmaven.repo.local=/m2 test
