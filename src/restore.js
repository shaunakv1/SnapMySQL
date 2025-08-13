import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireEnv } from "./config.js";
import { log } from "./logger.js";
import { s3Client, getLatestKey, getJson, putJsonAtomic } from "./s3.js";
import { dropAndRecreateDatabase, killDbConnections, restoreFromSqlGz } from "./mysql.js";
import { notifySlack } from "./notify.js";
import { execa } from "execa";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { fileMd5, isoUtcNow } from "./util.js";

async function downloadS3ObjectToFile({ client, bucket, key, destPath }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const file = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.Body.pipe(file);
    res.Body.on("error", reject);
    file.on("finish", resolve);
  });
  return destPath;
}

export async function runRestore() {
  requireEnv();
  const db = cfg.tgt.db;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `snapmysql-restore-`));

  try {
    const client = s3Client(cfg.s3);

    // Prefer latest.json; fall back to legacy latest.txt
    const latestJsonKey = `${cfg.src.db}/latest.json`;
    let state = await getJson({ client, bucket: cfg.s3.bucket, key: latestJsonKey }).catch(() => null);
    let backupKey = null;
    if (state?.latest_backup?.key) {
      backupKey = state.latest_backup.key;
      const lastMd5 = state?.latest_restore?.checksum?.value || null;
      const newMd5  = state?.latest_backup?.checksum?.value || null;
      const skip = !!(newMd5 && lastMd5 && newMd5 === lastMd5);
      if (skip) {
        log.info({ backupKey, md5: newMd5 }, "Restore skipped (checksum unchanged).");
        await notifySlack(cfg.slackWebhook, `⏭️ SnapMySQL restore skipped for *${db}* – latest backup MD5 matches last restored.`);
        return backupKey;
      }
    } else {
      const legacy = await getLatestKey({ client, bucket: cfg.s3.bucket, db: cfg.src.db });
      if (!legacy) throw new Error(`No latest.json or latest.txt found for db ${cfg.src.db}`);
      backupKey = legacy;
    }

    log.info({ latestKey: backupKey }, "Latest backup key resolved.");
    const tgzPath = path.join(workdir, "backup.tgz");
    await downloadS3ObjectToFile({ client, bucket: cfg.s3.bucket, key: backupKey, destPath: tgzPath });
    log.info({ tgzPath }, "Downloaded backup.");

    // Verify checksum if state has one
    const computedMd5 = await fileMd5(tgzPath);
    if (state?.latest_backup?.checksum?.value && state.latest_backup.checksum.value !== computedMd5) {
      throw new Error(`Checksum mismatch: expected ${state.latest_backup.checksum.value} but got ${computedMd5}`);
    }

    await execa("tar", ["-xzf", tgzPath, "-C", workdir]);
    const sqlGzPath = fs.readdirSync(workdir).find(f => f.endsWith(".sql.gz"));
    if (!sqlGzPath) throw new Error("Extracted archive missing .sql.gz");
    const fullSqlGzPath = path.join(workdir, sqlGzPath);

    await killDbConnections({ conn: cfg.tgt, db });
    await dropAndRecreateDatabase({ conn: cfg.tgt, db });

    await restoreFromSqlGz({ conn: cfg.tgt, db, sqlGzPath: fullSqlGzPath });

    // Update latest.json with latest_restore info (and bump restore counter)
    if (state) {
      const restoresTotal = (state?.stats?.restores_total || 0) + 1;
      const newState = {
        ...state,
        latest_restore: {
          key: backupKey,
          restored_at: isoUtcNow(),
          target: { host: cfg.tgt.host, port: cfg.tgt.port },
          checksum: { algo: "md5", value: computedMd5 }
        },
        stats: {
          backups_total: state?.stats?.backups_total || 0,
          restores_total: restoresTotal
        },
        updated_at: isoUtcNow()
      };
      await putJsonAtomic({ client, bucket: cfg.s3.bucket, key: latestJsonKey, json: newState });
    }

    await notifySlack(cfg.slackWebhook, `✅ SnapMySQL restore complete for *${db}*. Restored: \`${backupKey}\``);
    return backupKey;
  } catch (err) {
    log.error({ err }, "Restore failed.");
    await notifySlack(cfg.slackWebhook, `❌ SnapMySQL restore FAILED for *${cfg.tgt.db}*: ${String(err.message || err)}`);
    throw err;
  } finally {
    if (!cfg.keepLocalWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRestore().catch(() => process.exit(1));
}
