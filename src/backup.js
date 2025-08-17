import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireBackupEnv } from "./config.js";
import { mkLogger, newRid } from "./logger.js";
import { mysqldumpFull } from "./mysql.js";
import { s3Client, putJsonAtomic, putObject } from "./s3.js";
import { fileMd5, isoUtcNow } from "./util.js";

const log = mkLogger("backup");

export async function runBackup(rid = newRid("b")) {
  requireBackupEnv();
  const start = Date.now();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `snapmysql-backup-`));
  try {
    // 1) Dump + gzip via mysql.js helper
    const sqlGz = path.join(workdir, `${cfg.src.db}.sql.gz`);
    await mysqldumpFull({ conn: cfg.src, db: cfg.src.db, outFile: sqlGz });
    log.info("B_GZ_OK", { rid, sqlGz });

    // 2) Tarball the gz
    const tgz = path.join(workdir, `${cfg.src.db}-${isoUtcNow()}.tgz`);
    const { execa } = await import("execa");
    await execa("tar", ["-czf", tgz, "-C", workdir, path.basename(sqlGz)]);
    log.info("B_TGZ_OK", { rid, tgz });

    // 3) Upload to S3/Spaces
    const md5 = await fileMd5(tgz);
    const key = `${cfg.src.db}/${path.basename(tgz)}`;
    const client = s3Client(cfg.s3);
    const data = await fs.promises.readFile(tgz);
    await putObject({ client, bucket: cfg.s3.bucket, key, body: data });
    log.info("B_UPLOAD_OK", { rid, key });

    // 4) Update latest.json atomically
    const latestKey = `${cfg.src.db}/latest.json`;
    const json = {
      version: 1,
      database: cfg.src.db,
      bucket: cfg.s3.bucket,
      path_prefix: `${cfg.src.db}/`,
      latest_backup: {
        key,
        size_bytes: data.length,
        created_at: isoUtcNow(),
        source: { host: cfg.src.host, port: cfg.src.port },
        checksum: { algo: "md5", value: md5 }
      },
      stats: { backups_total: 0, restores_total: 0 },
      updated_at: isoUtcNow()
    };
    await putJsonAtomic({ client, bucket: cfg.s3.bucket, key: latestKey, json });
    log.info("B_STATE_OK", { rid, key: latestKey });

    log.info("SUMMARY", { rid, db: cfg.src.db, key, md5, elapsed_ms: Date.now() - start, action: "uploaded" });
    return key;
  } finally {
    if (!cfg.keepLocalWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackup().catch(() => process.exit(1));
}
