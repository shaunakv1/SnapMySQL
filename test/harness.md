# Test Harness

This profile spins up **source MySQL**, **target MySQL**, and **MinIO** locally and seeds the source DB
with tables, data, routines, a trigger, and an event so you can validate full-fidelity backup/restore.

## How to run

```bash
# from mysql-db-backups/
cp .env.example .env   # already pre-wired for local services
docker compose --profile test up --build -d
# wait ~10s for src-mysql to boot and initialize

# Manually drive a test cycle (optional)
docker compose exec snapmysql node src/backup.js
docker compose exec snapmysql node src/restore.js
docker compose exec snapmysql node src/verify.js

# Inspect
open http://localhost:9001           # MinIO Console (minioadmin/minioadmin)
docker compose exec tgt-mysql mysql -uroot -ptgtpassword -e "SHOW FUNCTION STATUS WHERE Db='mydb';"
docker compose exec tgt-mysql mysql -uroot -ptgtpassword -e "SHOW PROCEDURE STATUS WHERE Db='mydb';"
docker compose exec tgt-mysql mysql -uroot -ptgtpassword -e "SHOW TRIGGERS FROM mydb;"
docker compose exec tgt-mysql mysql -uroot -ptgtpassword -e "SHOW EVENTS FROM mydb;"
docker compose exec tgt-mysql mysql -uroot -ptgtpassword -e "SELECT COUNT(*) FROM mydb.users;"
```

## Notes

- The source DB is seeded via MySQL's `/docker-entrypoint-initdb.d/` mechanism with multiple SQL files.
- We enable `event_scheduler=ON` on both source and target so events are handled.
- The scheduler (snapmysql) will still run based on `CRON_BACKUP` / `CRON_RESTORE` in `.env`.
