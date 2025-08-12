#!/usr/bin/env bash
set -euo pipefail
echo "Running one backup -> restore -> verify cycle..."
docker compose exec snapmysql node src/backup.js
docker compose exec snapmysql node src/restore.js
docker compose exec snapmysql node src/verify.js
echo "Done."
