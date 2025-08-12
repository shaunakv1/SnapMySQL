# SnapMySQL – Requirements (v1)

## System Requirements
1. Source DB: MySQL (currently AWS RDS; may change).
2. Target DB: MySQL (currently DigitalOcean Managed MySQL; may change).
3. Backups are *full dumps* including tables, views, routines, triggers, and events.
4. Upload to S3-compatible storage (DigitalOcean Spaces) as:
   `<database_name>/<ISO8601-UTC>.tgz` (e.g., `mydb/2025-04-26T03:54:58Z.tgz`).
5. Backups run on a cron schedule and upload/update a `<db>/latest.txt` object storing the key of the most recent dump.
6. Restore runs on a cron schedule and restores the *latest* dump.
7. Goal: after restore, target should be logically identical to source (schema, routines, triggers, events, data).
8. Restore flow:
   - Kill sessions on target DB `<db>`.
   - Create `<db>_previous` (timestamped suffix optional).
   - Move all tables from `<db>` to `<db>_previous` (best-effort renaming since MySQL removed RENAME DATABASE).
   - Drop and recreate clean `<db>` and restore into it.
9. Verify post-restore (optional): compare table lists and row counts (best effort) between source and target.

## System Design
1. Runs in existing Kubernetes cluster.
2. Separate scripts for backup, restore, S3, notify, verify, etc.
3. Docker image consumes env vars for both source and target and runs scripts.
4. Local testing via `docker-compose`; production via K8s Deployment (always-on) + Node cron.
5. Failures trigger Slack alerts; successes notify Slack with the restored key.

## Infrastructure
1. GitHub Actions builds/pushes image to GHCR on changes.
2. K8s pulls the image.
3. Code lives in existing repo under `mysql-db-backups/`.

## Code Design
1. Uses `mysqldump` and `mysql` CLI (from official `mysql` base image).
2. Node.js for orchestration (scheduling, S3, Slack).
3. Official `mysql` Docker image used as base.
4. Scripts are modular and clean: `backup`, `restore`, `s3`, `notify`, `verify`, `mysql` helpers, and `main` orchestrator.
