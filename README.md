# SnapMySQL

Full-fidelity, scheduled **MySQL backup & restore** for Kubernetes and local dev.  
It takes a complete dump (data + schema + routines + events + triggers) from a **source** MySQL and restores it into a **target** MySQL, storing artifacts in **S3-compatible** object storage (e.g., DigitalOcean Spaces, MinIO).

**Ethos:** keep it simple and reliable. A plain `mysqldump` → `tar.gz` → S3 → `mysql` restore pipeline. No fancy partial syncs; just fast, production-ready full reproduction of one database to another.

---

## Highlights

- ✅ **Full dumps**: includes routines, triggers, events, views
- ☁️ **S3-compatible storage**: DigitalOcean Spaces, MinIO, AWS S3, etc.
- ⏱️ **Cron scheduling**: backup and restore on separate schedules
- 🔁 **Target kept in sync**: drop & recreate then restore (clean, consistent)
- 🧭 **State file**: `latest.json` in the bucket tracks most recent backup and last restored artifact (with MD5)
- 🧪 **Local harness**: docker-compose with seeded source DB and MinIO
- 🔕 **Clean logs**: one-line, grep-friendly event codes
- 🔔 **Slack notifications** (optional)
- 🧰 **Manual restore modes**: restore a specific `--file` or S3 `--key` without touching scheduler state
- 🧯 **Ops controls**: split roles into separate pods/containers and pause with env flags

---

## Quick Start

> You can run SnapMySQL in **manual mode** (single shot) or as a **scheduler** (crons). Choose your setup below.

### A) Manual mode (Node.js on your machine)

Requirements:
- Node.js 20+
- `mysql` & `mysqldump` on PATH (or use the Docker method below)

1) Clone the repo and set environment variables (see **Environment** below).

2) Run a **one-off backup**:
```bash
node mysql-db-backups/src/backup.js
```

3) Run a **one-off restore** (normal latest):
```bash
node mysql-db-backups/src/restore.js
```

4) **Manual restore** from a specific file or S3 key (does **not** update `latest.json`):
```bash
# local tarball
node mysql-db-backups/src/restore.js --file /path/to/mydb-2025-08-13T03:15:00Z.tgz

# specific object key in S3/Spaces
node mysql-db-backups/src/restore.js --key mydb/2025-08-13T03:15:00Z.tgz

# restore into a different database name
node mysql-db-backups/src/restore.js --file /path/to/backup.tgz --db mydb_staging
# or via env
RESTORE_DB=mydb_staging node mysql-db-backups/src/restore.js
```

5) Run the **scheduler** (both backup & restore crons):
```bash
node mysql-db-backups/src/main.js
```

---

### B) Docker (build image locally)

Build:
```bash
docker build -t snapmysql:local .
```

Run one-off **backup**:
```bash
docker run --rm --env-file .env snapmysql:local node src/backup.js
```

Run one-off **restore** (latest):
```bash
docker run --rm --env-file .env snapmysql:local node src/restore.js
```

**Manual restore** with flags:
```bash
# local tarball mounted into /backup
docker run --rm --env-file .env -v /path/to:/backup snapmysql:local \
  node src/restore.js --file /backup/mydb-2025-08-13T03:15:00Z.tgz

# specific S3 key
docker run --rm --env-file .env snapmysql:local \
  node src/restore.js --key mydb/2025-08-13T03:15:00Z.tgz
```

Run **scheduler** (both crons):
```bash
docker run --rm --env-file .env snapmysql:local
```

Split roles into two containers:
```bash
# backup only
docker run --rm --env-file .env -e ROLE=backup snapmysql:local
# restore only
docker run --rm --env-file .env -e ROLE=restore snapmysql:local
```

Pause at runtime:
```bash
# skip backup ticks
docker run --rm --env-file .env -e PAUSE_BACKUP=true snapmysql:local
# skip restore ticks
docker run --rm --env-file .env -e PAUSE_RESTORE=true snapmysql:local
```

---

### C) Prebuilt image (GitHub Packages)

Once published, you can pull:
```bash
docker pull ghcr.io/shaunakv1/snapmysql:latest
```
---

### D) Docker-Compose Test Harness

This repo includes a **test profile** that launches:
- `src-mysql` (seeded with users/orders, routines, views, triggers, events)
- `tgt-mysql`
- `minio` (S3-compatible store)
- one `snapmysql` service running the scheduler

Run:
```bash
docker compose --profile test up --build
# logs
docker compose --profile test logs -f snapmysql
```

Connect with a MySQL client:
- Source: `localhost:3306` (root / `srcpassword`)  
- Target: `localhost:3307` (root / `tgtpassword`)

MinIO Console:
- `http://localhost:9001`
- user/pass: `minioadmin` / `minioadmin`  
Bucket: `my-mysql-backups`

---

## Environment Variables

> These are read by SnapMySQL at runtime (Node or Docker). Put them in your `.env`.

### Source DB (what you back up)
```
SRC_DB_HOST=src-mysql         # or your RDS host
SRC_DB_PORT=3306
SRC_DB_USER=root
SRC_DB_PASS=srcpassword
SRC_DB_NAME=mydb
```

### Target DB (where you restore)
```
TGT_DB_HOST=tgt-mysql
TGT_DB_PORT=3306
TGT_DB_USER=root
TGT_DB_PASS=tgtpassword
TGT_DB_NAME=mydb
```

### S3 / Spaces
```
S3_ENDPOINT=http://minio:9000       # e.g., https://nyc3.digitaloceanspaces.com
S3_REGION=us-east-1                 # region value (Spaces accepts any)
S3_ACCESS_KEY_ID=xxxxxxxx
S3_SECRET_ACCESS_KEY=xxxxxxxx
S3_BUCKET=my-mysql-backups
```

### Scheduler
```
CRON_BACKUP=*/10 * * * *     # when to run backups
CRON_RESTORE=*/15 * * * *    # when to run restores
CRON_TZ=UTC                  # timezone for node-cron
ROLE=both                    # backup | restore | both
PAUSE_BACKUP=false           # true|1|yes to skip the tick
PAUSE_RESTORE=false          # true|1|yes to skip the tick
```

### Notifications & Logging
```
SLACK_WEBHOOK_URL=           # optional; if unset, notifications are skipped
LOG_STACK=false              # true to print stack traces on ERROR
```

### Advanced
```
RESTORE_DB=                  # override target db name for manual restore or CLI --db
KEEP_LOCAL_WORKDIR=false     # if true, keeps temp working dir (debugging)
```

> **Note:** SnapMySQL shells out to `mysqldump` and `mysql` and passes passwords via `-p...`. If this is a concern in your environment, switch to ephemeral `MYSQL_PWD` or ensure container isolation and restricted logs.

---

## Architecture

### Backup flow
1. **Dump:** `mysqldump --single-transaction --routines --events --triggers --hex-blob --set-gtid-purged=OFF --databases <db>`
2. **Compress:** stream → `gzip`; **package:** `tar.gz` with a small `manifest.json`
3. **Checksum:** compute file MD5
4. **Upload:** to `s3://<bucket>/<db>/<ISO8601>.tgz`
5. **State:** atomically write `<db>/latest.json` (see below)
6. **Notify:** Slack (optional)

### Restore flow (scheduled)
1. **Read state:** `<db>/latest.json`  
2. **Guard:** if `latest_backup.md5` equals `latest_restore.md5`, **skip**
3. **Download & verify MD5**
4. **Kill connections → drop & recreate target DB**
5. **Restore:** `mysql < dump.sql`
6. **State:** update `latest.json.latest_restore`
7. **Notify & Verify:** optional verification (rowcount + object presence), Slack (optional)

### Restore flow (manual)
- `--file` or `--key` **does not update** `latest.json` (by design)
- You can also target a different DB via `--db` or `RESTORE_DB`

### Logging
Single-line, grep-friendly events, e.g.:
```
2025-08-13 03:20:00Z [INFO]  backup  B_TGZ_DONE       rid=b2 db=mydb key=mydb/2025-08-13T03:20:00Z.tgz
2025-08-13 03:20:00Z [INFO]  restore R_RESTORE_OK     rid=r2 db=mydb dur_ms=1234
2025-08-13 03:20:00Z [INFO]  restore SUMMARY          rid=r2 db=mydb key=... action=restored verify=ok elapsed_ms=...
```

---

## `latest.json` — the state file

Path: `s3://<bucket>/<db>/latest.json`  
Updated **after each backup** and **after each scheduled restore** (not manual).

Example:
```json
{
  "version": 1,
  "database": "mydb",
  "bucket": "my-mysql-backups",
  "path_prefix": "mydb/",
  "latest_backup": {
    "key": "mydb/2025-08-13T03:15:00Z.tgz",
    "size_bytes": 123456,
    "created_at": "2025-08-13T03:15:01Z",
    "source": { "host": "src-mysql", "port": 3306 },
    "checksum": { "algo": "md5", "value": "d41d8cd98f00b204e9800998ecf8427e" }
  },
  "latest_restore": {
    "key": "mydb/2025-08-13T03:15:00Z.tgz",
    "restored_at": "2025-08-13T03:20:05Z",
    "target": { "host": "tgt-mysql", "port": 3306 },
    "checksum": { "algo": "md5", "value": "d41d8cd98f00b204e9800998ecf8427e" }
  },
  "policy": { "restore_only_if_new_checksum": true },
  "stats": { "backups_total": 7, "restores_total": 6 },
  "updated_at": "2025-08-13T03:20:05Z"
}
```

Behavior:
- **Backups** always update `latest_backup` and bump `stats.backups_total`.
- **Scheduled restores** update `latest_restore` and bump `stats.restores_total`.
- **Manual restores** (`--file`/`--key`) **do not** modify `latest.json`.  
  This prevents accidental interaction with the scheduler.

Atomicity:
- State writes use a two-step put: write `latest.json.tmp` then `latest.json`.

---

## Examples

Run backups every 10 min; restores 5 min offset:
```env
CRON_BACKUP=*/10 * * * *
CRON_RESTORE=5-59/10 * * * *
CRON_TZ=UTC
```

Split roles into two Deployments (Kubernetes):
```yaml
# snapmysql-backup
env:
  - name: ROLE
    value: "backup"
  - name: CRON_BACKUP
    value: "*/10 * * * *"
  - name: CRON_TZ
    value: "UTC"
# snapmysql-restore
env:
  - name: ROLE
    value: "restore"
  - name: CRON_RESTORE
    value: "5-59/10 * * * *"
  - name: CRON_TZ
    value: "UTC"
```

Pause restores during a maintenance window:
```bash
kubectl set env deploy/snapmysql-restore PAUSE_RESTORE=true
# later…
kubectl set env deploy/snapmysql-restore PAUSE_RESTORE-
```

---

## Contributing

PRs are welcome! Please:
- keep changes modular (scripts are small on purpose)
- stick to well-established tools (`mysqldump` / `mysql`, AWS SDK v3)
- prefer single-purpose, testable functions
- keep logging concise with the existing event codes

---

## License

MIT — see `LICENSE`.

---

## Why not logical replication or binlog sync?

Those are great for certain use cases, but they’re operationally heavier and less portable across providers. SnapMySQL aims to be the **90% solution**: easy to run anywhere, predictable, and fast to recover with artifacts you can hold onto (tarballs in object storage).

If you need point-in-time recovery or low-lag replicas, consider adding binlog archiving or using your cloud’s native tools **alongside** SnapMySQL.
