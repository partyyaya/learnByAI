#!/usr/bin/env bash
set -euo pipefail
verification_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$verification_dir"
python3 prepare.py
redis_container=""
cleanup() {
  if [ -n "$redis_container" ]; then docker rm -f "$redis_container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
redis_container="$(docker run --rm -d -p 127.0.0.1::6379 "${REDIS_IMAGE:-redis:7.2}" --save '' --appendonly no)"
for attempt in {1..30}; do
  if docker exec "$redis_container" redis-cli ping 2>/dev/null | rg -q '^PONG'; then break; fi
  if [ "$attempt" = 30 ]; then echo 'Redis readiness timeout' >&2; exit 1; fi
  sleep 0.2
done
redis_test_port="$(docker port "$redis_container" 6379/tcp | sed 's/.*://')"
printf 'Isolated Redis on localhost:%s\n' "$redis_test_port"
# Set MAVEN_OFFLINE=1 when the local Maven cache already has all dependencies.
maven_options=(-q "-Dreview.redis.port=$redis_test_port")
if [ "${MAVEN_OFFLINE:-0}" = 1 ]; then maven_options+=(-o); fi
mvn "${maven_options[@]}" test 2>&1 | tee target/verification.log
python3 cli_checks.py "$redis_container" | tee target/cli-checks.log
python3 - <<'PY'
from pathlib import Path
from xml.etree import ElementTree as ET
counts={k:0 for k in ('tests','failures','errors','skipped')}
for p in Path('target/surefire-reports').glob('TEST-*.xml'):
    r=ET.parse(p).getroot()
    for k in counts: counts[k]+=int(r.attrib[k])
print('JUnit:',counts)
assert counts['tests'] > 0 and counts['failures']==counts['errors']==counts['skipped']==0
PY
