import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireEnv } from "./config.js";
import { mkLogger, newRid } from "./logger.js";
import { s3Client, uploadFile, putJsonAtomic, getJson } from "./s3.js";
import { mysqldumpFull } from "./mysql.js";
import { notifySlack } from "./notify.js";
import { execa } from "execa";
import { fileMd5, isoUtcNow } from "./util.js";

const log = mkLogger("backup");

export async function runBackup(rid = newRid("b")) {
  requireEnv();
  const db = cfg.src.db;
  const start = Date.now();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `snapmysql-backup-`));
  log.info("B_START", { rid, db });
  try {
    const sqlGz = await mysqldumpFull({ conn: cfg.src, db, outDir: workdir });
    const sqlSize = (await fs.promises.stat(sqlGz)).size;
    log.info("B_DUMP_DONE", { rid, db, sql_gz_bytes: sqlSize });

    const manifestPath = path.join(workdir, "manifest.json");
    const meta = {
      database: db,
      created_at: isoUtcNow(),
      source: { host: cfg.src.host, port: cfg.src.port },
      format: "mysqldump+gzip+tar"
    };
    fs.writeFileSync(manifestPath, JSON.stringify(meta, null, 2));

    const iso = isoUtcNow();
    const key = `${db}/${iso}.tgz`;
    const tgzPath = path.join(workdir, `${db}-${iso}.tgz`);
    await execa("tar", ["-czf", tgzPath, "-C", workdir, path.basename(sqlGz), "manifest.json"]);
    log.info("B_TGZ_DONE", { rid, db, key, tgz: tgzPath });

    const md5 = await fileMd5(tgzPath);
    const size = fs.statSync(tgzPath).size;

    const client = s3Client(cfg.s3);
    await uploadFile({ client, bucket: cfg.s3.bucket, key, filePath: tgzPath, contentType: "application/gzip" });
    log.info("B_UPLOAD_OK", { rid, key });

    // Build latest.json (read previous if present to preserve counters and last restore info)
    const latestJsonKey = `${db}/latest.json`;
    const latest = await getJson({ client, bucket: cfg.s3.bucket, key: latestJsonKey }).catch(() => null);
    const backupsTotal  = (latest?.stats?.backups_total || 0) + 1;
    const restoresTotal = (latest?.stats?.restores_total || 0);

    const newState = {
      version: 1,
      database: db,
      bucket: cfg.s3.bucket,
      path_prefix: `${db}/`,
      latest_backup: {
        key,
        size_bytes: size,
        created_at: isoUtcNow(),
        source: { host: cfg.src.host, port: cfg.src.port },
        checksum: { algo: "md5", value: md5 }
      },
      latest_restore: latest?.latest_restore ?? null,
      policy: { restore_only_if_new_checksum: true },
      stats: { backups_total: backupsTotal, restores_total: restoresTotal },
      updated_at: isoUtcNow()
    };

    await putJsonAtomic({ client, bucket: cfg.s3.bucket, key: latestJsonKey, json: newState });
    log.info("B_STATE_OK", { rid, key: latestJsonKey });

    await notifySlack(cfg.slackWebhook, `✅ SnapMySQL backup complete for *${db}*. Uploaded: \`${key}\``);
    log.info("SUMMARY", { rid, db, key, md5, size, elapsed_ms: Date.now() - start });
    log.info("B_DONE", { rid, db, elapsed_ms: Date.now() - start });
    return key;
  } catch (err) {
    log.error("B_FAIL", { rid, db, err: (err && err.message) || String(err) });
    await notifySlack(cfg.slackWebhook, `❌ SnapMySQL backup FAILED for *${cfg.src.db}*: ${String(err.message || err)}`);
    throw err;
  } finally {
    if (!cfg.keepLocalWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackup().catch(() => process.exit(1));
}
