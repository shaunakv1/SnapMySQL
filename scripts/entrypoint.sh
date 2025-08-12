#!/usr/bin/env bash
set -euo pipefail

echo "mysql client: $(mysql --version || true)"
echo "mysqldump: $(mysqldump --version || true)"
echo "node: $(node -v || true)"

wait_mysql() {
  local host="$1" port="$2" user="$3" pass="$4"
  echo "Waiting for MySQL at $host:$port ..."
  for i in {1..60}; do
    if mysqladmin ping -h "$host" -P "$port" -u "$user" -p"$pass" --silent; then
      echo "MySQL at $host:$port is ready."
      return 0
    fi
    sleep 2
  done
  echo "ERROR: MySQL at $host:$port not ready in time."
  return 1
}

wait_http() {
  local url="$1"
  echo "Waiting for HTTP $url ..."
  for i in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "OK: $url"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: $url not reachable."
  return 1
}

# Only wait if we are in test profile (envs point to compose services)
if [[ "${SRC_DB_HOST:-}" == "src-mysql" ]]; then
  wait_mysql "$SRC_DB_HOST" "${SRC_DB_PORT:-3306}" "${SRC_DB_USER:-root}" "${SRC_DB_PASSWORD:-}"
fi
if [[ "${TGT_DB_HOST:-}" == "tgt-mysql" ]]; then
  wait_mysql "$TGT_DB_HOST" "${TGT_DB_PORT:-3306}" "${TGT_DB_USER:-root}" "${TGT_DB_PASSWORD:-}"
fi
if [[ "${S3_ENDPOINT:-}" == "http://minio:9000" ]]; then
  wait_http "http://minio:9000/minio/health/live"
fi

exec node src/main.js
