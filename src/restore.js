import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg, requireEnv } from "./config.js";
import { log } from "./logger.js";
import { s3Client, getLatestKey } from "./s3.js";
import { archiveExistingDatabase, killDbConnections, restoreFromSqlGz } from "./mysql.js";
import { notifySlack } from "./notify.js";
import { execa } from "execa";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export async function runRestore() {
  requireEnv();
  const db = cfg.tgt.db;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `snapmysql-restore-`));

  try {
    const client = s3Client(cfg.s3);
    const latestKey = await getLatestKey({ client, bucket: cfg.s3.bucket, db: cfg.src.db });
    if (!latestKey) throw new Error(`No latest.txt found for db ${cfg.src.db}`);
    log.info({ latestKey }, "Latest backup key resolved.");

    const res = await client.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: latestKey }));
    const tgzPath = path.join(workdir, "backup.tgz");
    const file = fs.createWriteStream(tgzPath);
    await new Promise((resolve, reject) => {
      res.Body.pipe(file);
      res.Body.on("error", reject);
      file.on("finish", resolve);
    });
    log.info({ tgzPath }, "Downloaded backup.");

    await execa("tar", ["-xzf", tgzPath, "-C", workdir]);
    const sqlGzPath = fs.readdirSync(workdir).find(f => f.endsWith(".sql.gz"));
    if (!sqlGzPath) throw new Error("Extracted archive missing .sql.gz");
    const fullSqlGzPath = path.join(workdir, sqlGzPath);

    await killDbConnections({ conn: cfg.tgt, db });
    await archiveExistingDatabase({ conn: cfg.tgt, db });

    await restoreFromSqlGz({ conn: cfg.tgt, db, sqlGzPath: fullSqlGzPath });

    await notifySlack(cfg.slackWebhook, `✅ SnapMySQL restore complete for *${db}*. Restored: \`${latestKey}\``);
    return latestKey;
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
