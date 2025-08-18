import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireRestoreEnv } from "./config.js";
import { mkLogger, newRid } from "./logger.js";
import { s3Client, getLatestKey, getJson, putJsonAtomic } from "./s3.js";
import { dropAndRecreateDatabase, killDbConnections, restoreFromSqlGz } from "./mysql.js";
import { notifySlack } from "./notify.js";
import { execa } from "execa";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { fileMd5, isoUtcNow } from "./util.js";

const log = mkLogger("restore");

function parseArgs(argv) {
  const args = { file: null, db: null, key: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && argv[i+1]) { args.file = argv[++i]; continue; }
    if (a.startsWith("--file=")) { args.file = a.split("=",2)[1]; continue; }
    if (a === "--db" && argv[i+1]) { args.db = argv[++i]; continue; }
    if (a.startsWith("--db=")) { args.db = a.split("=",2)[1]; continue; }
    if (a === "--key" && argv[i+1]) { args.key = argv[++i]; continue; }
    if (a.startsWith("--key=")) { args.key = a.split("=",2)[1]; continue; }
  }
  return args;
}

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

export async function runRestore(rid = newRid("r"), cliOpts = null) {
  requireRestoreEnv();
  const argvOpts = cliOpts || parseArgs(process.argv.slice(2));
  const manual = !!(argvOpts.file || argvOpts.key);
  const overrideDb = argvOpts.db || process.env.RESTORE_DB || cfg.tgt.db;
  const db = overrideDb;
  const start = Date.now();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `snapmysql-restore-`));
  log.info("R_START", { rid, db, manual });

  try {
    const client = s3Client(cfg.s3);
    const latestJsonKey = `${cfg.src.db}/latest.json`;

    let state = null;
    let backupKey = null;
    let tgzPath = path.join(workdir, "backup.tgz");
    let computedMd5 = null;

    if (argvOpts.file) {
      const abs = path.isAbsolute(argvOpts.file) ? argvOpts.file : path.resolve(argvOpts.file);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
      tgzPath = abs;
      backupKey = `file://${abs}`;
      log.info("R_MANUAL_FILE", { rid, path: abs });
      computedMd5 = await fileMd5(tgzPath);
    } else if (argvOpts.key) {
      backupKey = argvOpts.key;
      log.info("R_MANUAL_KEY", { rid, db, key: backupKey });
      await downloadS3ObjectToFile({ client, bucket: cfg.s3.bucket, key: backupKey, destPath: tgzPath });
      const bytes = (await fs.promises.stat(tgzPath)).size;
      log.info("R_DOWNLOAD_OK", { rid, key: backupKey, bytes });
      computedMd5 = await fileMd5(tgzPath);
    } else {
      state = await getJson({ client, bucket: cfg.s3.bucket, key: latestJsonKey }).catch(() => null);
      if (state?.latest_backup?.key) {
        backupKey = state.latest_backup.key;
        log.info("R_STATE_OK", { rid, db, key: backupKey, md5: state.latest_backup.checksum?.value });
        const lastMd5 = state?.latest_restore?.checksum?.value || null;
        const newMd5  = state?.latest_backup?.checksum?.value || null;
        const skip = !!(newMd5 && lastMd5 && newMd5 === lastMd5);
        if (skip) {
          log.info("R_SKIP_SAME", { rid, db, key: backupKey, md5: newMd5 });
          await notifySlack(cfg.slackWebhook, `⏭️ SnapMySQL restore skipped for *${db}* – latest backup MD5 matches last restored.`, rid);
          return backupKey;
        }
        await downloadS3ObjectToFile({ client, bucket: cfg.s3.bucket, key: backupKey, destPath: tgzPath });
        const bytes = (await fs.promises.stat(tgzPath)).size;
        log.info("R_DOWNLOAD_OK", { rid, key: backupKey, bytes });
        computedMd5 = await fileMd5(tgzPath);
        if (state?.latest_backup?.checksum?.value && state.latest_backup.checksum.value !== computedMd5) {
          throw new Error(`Checksum mismatch: expected ${state.latest_backup.checksum.value} but got ${computedMd5}`);
        }
      } else {
        const legacy = await getLatestKey({ client, bucket: cfg.s3.bucket, db: cfg.src.db });
        if (!legacy) {
          log.warn("R_STATE_NONE", { rid, db: cfg.src.db, reason: "no-latest-state", action: "skip" });
          await notifySlack(cfg.slackWebhook, `⏭️ SnapMySQL restore skipped for *${cfg.tgt.db}* – no latest backup state yet.`, rid);
          return null;
        }
        backupKey = legacy;
        log.info("R_KEY", { rid, db, key: backupKey });
        await downloadS3ObjectToFile({ client, bucket: cfg.s3.bucket, key: backupKey, destPath: tgzPath });
        const bytes = (await fs.promises.stat(tgzPath)).size;
        log.info("R_DOWNLOAD_OK", { rid, key: backupKey, bytes });
        computedMd5 = await fileMd5(tgzPath);
      }
    }

    await execa("tar", ["-xzf", tgzPath, "-C", workdir]);
    const sqlGzPath = fs.readdirSync(workdir).find(f => f.endsWith(".sql.gz"));
    if (!sqlGzPath) throw new Error("Extracted archive missing .sql.gz");
    const fullSqlGzPath = path.join(workdir, sqlGzPath);

    await killDbConnections(cfg.tgt, db);
    log.info("R_KILL_OK", { rid, db });
    await dropAndRecreateDatabase(cfg.tgt, db);
    log.info("R_DROPCREATE_OK", { rid, db });

    const t0 = Date.now();
    await restoreFromSqlGz({ conn: cfg.tgt, db, sqlGzPath: fullSqlGzPath });
    log.info("R_RESTORE_OK", { rid, db, dur_ms: Date.now() - t0 });

    if (!manual) {
      try {
        const st = state || {};
        const restoresTotal = (st?.stats?.restores_total || 0) + 1;
        const newState = {
          ...(st || {}),
          version: st?.version || 1,
          database: st?.database || cfg.src.db,
          bucket: st?.bucket || cfg.s3.bucket,
          path_prefix: st?.path_prefix || `${cfg.src.db}/`,
          latest_backup: st?.latest_backup || null,
          latest_restore: {
            key: backupKey,
            restored_at: isoUtcNow(),
            target: { host: cfg.tgt.host, port: cfg.tgt.port },
            checksum: { algo: "md5", value: (await fileMd5(tgzPath)) }
          },
          stats: {
            backups_total: st?.stats?.backups_total || 0,
            restores_total: restoresTotal
          },
          updated_at: isoUtcNow()
        };
        const latestJsonKey = `${cfg.src.db}/latest.json`;
        await putJsonAtomic({ client, bucket: cfg.s3.bucket, key: latestJsonKey, json: newState });
        log.info("R_STATE_OK", { rid, key: latestJsonKey });
      } catch {}
    } else {
      log.info("R_STATE_SKIP", { rid, reason: "manual" });
    }

    await notifySlack(cfg.slackWebhook, `✅ SnapMySQL restore complete for *${db}*.`, rid);
    log.info("SUMMARY", { rid, db, key: backupKey, elapsed_ms: Date.now() - start, action: "restored" });
    log.info("R_DONE", { rid, db, restored_key: backupKey, elapsed_ms: Date.now() - start });
    return backupKey;
  } catch (err) {
    log.error("R_FAIL", { rid, db, err: (err && err.message) || String(err) });
    await notifySlack(cfg.slackWebhook, `❌ SnapMySQL restore FAILED for *${cfg.tgt.db}*: ${String(err.message || err)}`, rid);
    throw err;
  } finally {
    if (!cfg.keepLocalWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRestore().catch(() => process.exit(1));
}
