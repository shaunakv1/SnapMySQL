import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireEnv } from "./config.js";
import { log } from "./logger.js";
import { s3Client, uploadFile, putJsonAtomic, getJson } from "./s3.js";
import { mysqldumpFull } from "./mysql.js";
import { notifySlack } from "./notify.js";
import { execa } from "execa";
import { fileMd5, isoUtcNow } from "./util.js";

export async function runBackup() {
  requireEnv();
  const db = cfg.src.db;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `snapmysql-backup-`));
  try {
    const sqlGz = await mysqldumpFull({ conn: cfg.src, db, outDir: workdir });

    const manifestPath = path.join(workdir, "manifest.json");
    const meta = {
      database: db,
      created_at: new Date().toISOString(),
      source: { host: cfg.src.host, port: cfg.src.port },
      format: "mysqldump+gzip+tar"
    };
    fs.writeFileSync(manifestPath, JSON.stringify(meta, null, 2));

    const iso = isoUtcNow();
    const key = `${db}/${iso}.tgz`;
    const tgzPath = path.join(workdir, `${db}-${iso}.tgz`);
    await execa("tar", ["-czf", tgzPath, "-C", workdir, path.basename(sqlGz), "manifest.json"]);
    log.info({ tgzPath }, "Created tarball.");

    const md5 = await fileMd5(tgzPath);
    const size = fs.statSync(tgzPath).size;

    const client = s3Client(cfg.s3);
    await uploadFile({ client, bucket: cfg.s3.bucket, key, filePath: tgzPath, contentType: "application/gzip" });

    // Build latest.json (read previous if present to preserve counters and last restore info)
    let latest = null;
    const latestJsonKey = `${db}/latest.json`
    latest = await getJson({ client, bucket: cfg.s3.bucket, key: latestJsonKey }).catch(() => null);

    const backupsTotal = (latest?.stats?.backups_total || 0) + 1;
    const restoresTotal = (latest?.stats?.restores_total || 0);

    const newState = {
      version: 1,
      database: db,
      bucket: cfg.s3.bucket,
      path_prefix: `${db}/`,
      latest_backup: {
        key,
        size_bytes: size,
        created_at: new Date().toISOString(),
        source: { host: cfg.src.host, port: cfg.src.port },
        checksum: { algo: "md5", value: md5 }
      },
      latest_restore: latest?.latest_restore ?? null,
      policy: { restore_only_if_new_checksum: true },
      stats: { backups_total: backupsTotal, restores_total: restoresTotal },
      updated_at: new Date().toISOString()
    };

    await putJsonAtomic({ client, bucket: cfg.s3.bucket, key: latestJsonKey, json: newState });

    await notifySlack(cfg.slackWebhook, `✅ SnapMySQL backup complete for *${db}*. Uploaded: \`${key}\``);
    return key;
  } catch (err) {
    log.error({ err }, "Backup failed.");
    await notifySlack(cfg.slackWebhook, `❌ SnapMySQL backup FAILED for *${cfg.src.db}*: ${String(err.message || err)}`);
    throw err;
  } finally {
    if (!cfg.keepLocalWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackup().catch(() => process.exit(1));
}
