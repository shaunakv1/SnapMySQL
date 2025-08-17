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
- 🧰 **Manual immediate runs** via `ROLE` + `RUN_IMMEDIATELY` (without waiting for cron)
- 🧯 **Ops controls**: split roles into separate pods/containers; pause streams with env flags

---

## Quick Start

> SnapMySQL can run as a **scheduler** (cron-driven) or in **manual/one-shot** mode using `ROLE` + `RUN_IMMEDIATELY`. Examples below use **`src/main.js`** (preferred) rather than calling sub-scripts directly.

### A) Manual mode (Node.js on your machine)

Requirements:
- Node.js 20+
- `mysql` & `mysqldump` on PATH (or use the Docker method below)

1) Set environment variables (see **Environment**).

2) Run a **one-off backup now** (no cron):
```bash
ROLE=backup RUN_IMMEDIATELY=true SKIP_CRON=true node mysql-db-backups/src/main.js
```

3) Run a **one-off restore of the latest backup**:
```bash
ROLE=restore RUN_IMMEDIATELY=true SKIP_CRON=true node mysql-db-backups/src/main.js
```

4) Restore into a **different database name** (manual latest):
```bash
ROLE=restore RUN_IMMEDIATELY=true SKIP_CRON=true RESTORE_DB=mydb_staging node mysql-db-backups/src/main.js
```

5) Run the **scheduler** (both cron streams enabled):
```bash
ROLE=both node mysql-db-backups/src/main.js
```

> Want to restore a **specific artifact** by key or file path? That’s supported via the restore CLI (e.g., `src/restore.js --key ...` or `--file ...`) and does **not** modify `latest.json`. Using `main.js` for targeted artifacts is on the roadmap (e.g., envs like `RESTORE_KEY/RESTORE_FILE`).

---

### B) Docker (build image locally)

Build:
```bash
docker build -t snapmysql:local .
```

Run **one-off backup** (no cron):
```bash
docker run --rm --env-file .env \
  -e ROLE=backup -e RUN_IMMEDIATELY=true -e SKIP_CRON=true \
  snapmysql:local
```

Run **one-off restore (latest)**:
```bash
docker run --rm --env-file .env \
  -e ROLE=restore -e RUN_IMMEDIATELY=true -e SKIP_CRON=true \
  snapmysql:local
```

Run **scheduler** (both crons):
```bash
docker run --rm --env-file .env \
  -e ROLE=both \
  snapmysql:local
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
docker run --rm --env-file .env -e ROLE=backup -e PAUSE_BACKUP=true snapmysql:local
# skip restore ticks
docker run --rm --env-file .env -e ROLE=restore -e PAUSE_RESTORE=true snapmysql:local
```

---

### C) Prebuilt image (GitHub Packages)

Once published, you can pull:
```bash
docker pull ghcr.io/shaunakv1/snapmysql:latest
```
(Usage is identical to the local image above.)

---

### D) Docker-Compose Test Harness

The repo includes a **test** profile that launches:
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

> Place these in your `.env` or export them before launching.  
> **Do not put comments on the same line** as cron expressions — `node-cron` treats them as part of the pattern.

### Source DB (what you back up)
```
SRC_DB_HOST=src-mysql                   # or your RDS host
SRC_DB_PORT=3306
SRC_DB_USER=root
SRC_DB_PASSWORD=srcpassword
SRC_DB_NAME=mydb
# Optional MySQL client SSL behavior (only if needed for your provider)
# SRC_DB_SSL_MODE=REQUIRED              # DISABLED | PREFERRED | REQUIRED | VERIFY_CA | VERIFY_IDENTITY
```

### Target DB (where you restore)
```
TGT_DB_HOST=tgt-mysql
TGT_DB_PORT=3306
TGT_DB_USER=root
TGT_DB_PASSWORD=tgtpassword
TGT_DB_NAME=mydb
# Optional MySQL client SSL behavior (only if needed)
# TGT_DB_SSL_MODE=REQUIRED
```

### S3 / Spaces
```
S3_ENDPOINT=http://minio:9000          # e.g., https://nyc3.digitaloceanspaces.com
S3_REGION=us-east-1                    # Spaces accepts any region value
S3_ACCESS_KEY_ID=xxxxxxxx
S3_SECRET_ACCESS_KEY=xxxxxxxx
S3_BUCKET=my-mysql-backups
```

### Scheduler & Roles
```
ROLE=both                               # backup | restore | both
CRON_BACKUP=*/10 * * * *                # backup cron
CRON_RESTORE=*/15 * * * *               # restore cron
CRON_TZ=UTC                             # timezone for node-cron

# Operational controls
PAUSE_BACKUP=false                      # true|1|yes to skip backup ticks
PAUSE_RESTORE=false                     # true|1|yes to skip restore ticks
SKIP_CRON=false                         # true to disable scheduler entirely (useful for manual runs)
RUN_IMMEDIATELY=false                   # true to execute the ROLE task(s) now (once) without waiting
```

### Notifications & Logging
```
SLACK_WEBHOOK_URL=                      # optional; if unset, notifications are skipped
LOG_LEVEL=info                          # trace|debug|info|warn|error
LOG_STACK=false                         # true to print stack traces on ERROR
```

### Advanced
```
RESTORE_DB=                             # override target DB name for a restore (manual/latest)
KEEP_LOCAL_WORKDIR=false                # true → keep temp working dir for debugging
```

> **Security note:** SnapMySQL shells out to `mysqldump` and `mysql` and passes passwords via `-p...`. If this is a concern, consider ephemeral `MYSQL_PWD` inside the container, ensure container isolation, and restrict logs.

---

## Architecture

### Backup flow
1. **Dump:** `mysqldump --single-transaction --routines --events --triggers --hex-blob --set-gtid-purged=OFF --databases <db>` (streamed → gzip)
2. **Package:** tarball `mydb-<ISO8601>.tgz` (includes `mydb.sql.gz` and a tiny `manifest.json`)
3. **Checksum:** compute file MD5
4. **Upload:** `s3://<bucket>/<db>/<ISO8601>.tgz`
5. **State:** atomically write `<db>/latest.json` (see below)
6. **Notify:** Slack (optional)

### Restore flow (scheduled)
1. **Read state:** `<db>/latest.json`
2. **Guard:** if `latest_backup.checksum.value` equals `latest_restore.checksum.value`, **skip**
3. **Download & verify MD5**
4. **Kill connections → drop & recreate target DB**
5. **Restore:** stream `gunzip → mysql`
6. **State:** update `latest.json.latest_restore`
7. **Notify & Verify:** optional verification (rowcount + object presence), Slack (optional)

### Restore flow (manual immediate via `main.js`)
- Use `ROLE=restore RUN_IMMEDIATELY=true SKIP_CRON=true` to restore the **latest**.
- Set `RESTORE_DB` to target a different DB name.
- Manual latest restores **do update** `latest.json.latest_restore` *only if* they are part of the scheduled mode. Manual targeted artifacts (below) **do not** modify state.

### Targeted artifact restore (advanced)
- Restoring a specific S3 key or local tarball is supported via the restore CLI:  
  `src/restore.js --key <db/YYYY-MM-DDTHH:MM:SSZ.tgz>` or `--file /path/to.tgz`  
  This **does not** modify `latest.json` by design.

### Logging
Single-line, grep-friendly events, e.g.:
```
2025-08-13 03:20:00Z [INFO ] main    SCHED_START       role=both backup=*/10 * * * * restore=*/15 * * * * tz=UTC
2025-08-13 03:20:00Z [INFO ] backup  B_TGZ_DONE        rid=b2 db=mydb key=mydb/2025-08-13T03:20:00Z.tgz size=123456 md5=abc...
2025-08-13 03:20:00Z [INFO ] restore R_RESTORE_OK      rid=r2 db=mydb dur_ms=1234
2025-08-13 03:20:00Z [INFO ] restore SUMMARY           rid=r2 db=mydb key=... action=restored verify=ok elapsed_ms=...
```

---

## `latest.json` — the state file

Path: `s3://<bucket>/<db>/latest.json`  
Updated **after each backup** and **after each scheduled restore**. Targeted manual restores (specific `--key/--file`) **do not** update state.

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
- **Manual targeted restores** (`--file`/`--key`) **do not** modify `latest.json`.

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

Those are great for some use cases, but they’re operationally heavier and less portable across providers. SnapMySQL targets the **90% solution**: easy to run anywhere, predictable, and fast to recover with artifacts you can hold onto (tarballs in object storage).

If you need point-in-time recovery or low-lag replicas, consider adding binlog archiving or using your cloud’s native tools **alongside** SnapMySQL.
