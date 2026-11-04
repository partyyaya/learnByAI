#!/bin/sh
set -eu
# API is updated only after the independent migration job succeeds.
docker compose -f compose.production.yaml config --quiet
docker compose -f compose.production.yaml up -d --wait postgres cache-redis job-redis
docker compose -f compose.production.yaml run --rm migrate
docker compose -f compose.production.yaml up -d --wait api worker dispatcher proxy
docker compose -f compose.production.yaml run --rm verifier
