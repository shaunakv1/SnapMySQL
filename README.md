# SnapMySQL – MySQL Backup & Restore for Kubernetes

Back up a source MySQL to S3 (DigitalOcean Spaces compatible) and restore the latest dump into a target MySQL on a schedule.
Includes Slack notifications, local Docker Compose, K8s manifests, and GH Actions image publishing.

## Quick Start (Local Compose)

1. Copy `.env.example` to `.env` and update values (defaults are set for local compose services).
2. Start the stack (includes MinIO, source MySQL, target MySQL, and SnapMySQL scheduler):
   ```bash
   docker compose up --build
   ```
3. Create the S3 bucket once (done automatically by `minio-setup` container with defaults).
4. Trigger a manual backup/restore inside the running SnapMySQL container:
   ```bash
   docker compose exec snapmysql node src/backup.js
   docker compose exec snapmysql node src/restore.js
   ```
5. Check MinIO Console at http://localhost:9001 (user: `minioadmin`, pass: `minioadmin`).

**NOTE:** The scheduler runs inside the container based on `CRON_BACKUP` and `CRON_RESTORE` in `.env`.

## Kubernetes

1. Create secrets (edit `k8s/secret.example.yaml` with real values and apply):
   ```bash
   kubectl apply -f k8s/secret.example.yaml
   ```
2. Apply configMap and deployment:
   ```bash
   kubectl apply -f k8s/configmap.yaml
   kubectl apply -f k8s/deployment.yaml
   ```

## How it Works (Local)

- **Source DB**: `src-mysql` service on the compose network.
- **Target DB**: `tgt-mysql` service on the compose network.
- **S3**: MinIO (`minio:9000`), with a bucket created by `minio-setup` service.
- **Scheduler**: `snapmysql` runs a Node cron that kicks off backup & restore based on env vars.

## Safety and Verification

- On restore, we kill connections to target DB, archive its tables to `<db>_previous`, drop & recreate `<db>`, then restore the dump.
- Optional post-restore verification compares table presence and row-counts (set `VERIFY_AFTER_RESTORE=true`).


## Test Profile (with seed data)

Use Compose **profiles** to bring up the full local test harness (source/target MySQL and MinIO).

```bash
# from mysql-db-backups/
cp .env.example .env
docker compose --profile test up --build -d
# optional: run one full cycle
./test/run-once.sh
```

This seeds the **source** DB with tables, rows, a view, routines, a trigger, and an event (see `test/seed/*.sql`).
