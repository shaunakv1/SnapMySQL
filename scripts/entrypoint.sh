#!/usr/bin/env bash
set -euo pipefail

mysql --version || true
mysqldump --version || true
node -v || true

exec node src/main.js
