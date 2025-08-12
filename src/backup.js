import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireEnv } from "./config.js";
import { log } from "./logger.js";
import { s3Client, uploadFile, putText } from "./s3.js";
import { mysqldumpFull } from "./mysql.js";
import { notifySlack } from "./notify.js";
import { execa } from "execa";

function isoUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

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

    const iso = isoUtc();
    const key = `${db}/${iso}.tgz`;
    const tgzPath = path.join(workdir, `${db}-${iso}.tgz`);
    await execa("tar", ["-czf", tgzPath, "-C", workdir, path.basename(sqlGz), "manifest.json"]);
    log.info({ tgzPath }, "Created tarball.");

    const client = s3Client(cfg.s3);
    await uploadFile({ client, bucket: cfg.s3.bucket, key, filePath: tgzPath, contentType: "application/gzip" });

    const latestKey = `${db}/latest.txt`;
    await putText({ client, bucket: cfg.s3.bucket, key: latestKey, text: key });

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
