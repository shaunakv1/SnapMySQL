import cron from "node-cron";
import { cfg, requireEnv } from "./config.js";
import { log } from "./logger.js";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";
import { notifySlack } from "./notify.js";
import { verifySourceVsTarget } from "./verify.js";

async function scheduleAll() {
  requireEnv();
  log.info({ backup: cfg.cron.backup, restore: cfg.cron.restore, tz: cfg.cron.tz }, "Starting SnapMySQL scheduler.");

  cron.schedule(cfg.cron.backup, async () => {
    log.info("Backup cron fired.");
    try {
      await runBackup();
    } catch {}
  }, { timezone: cfg.cron.tz });

  cron.schedule(cfg.cron.restore, async () => {
    log.info("Restore cron fired.");
    try {
      const key = await runRestore();

      if (cfg.verifyAfterRestore) {
        const res = await verifySourceVsTarget();
        if (res.missingInTgt.length || res.extraInTgt.length || res.diffs.length) {
          await notifySlack(cfg.slackWebhook, `⚠️ Verification differences after restore \`${key}\`:\n` +
            `Missing in target: ${res.missingInTgt.join(", ") || "none"}\n` +
            `Extra in target: ${res.extraInTgt.join(", ") || "none"}\n` +
            `Row-count diffs: ${res.diffs.map(d => `${d.table}(${d.src} vs ${d.tgt})`).join(", ") || "none"}`);
        } else {
          await notifySlack(cfg.slackWebhook, `🔍 Verification OK after restore \`${key}\` – source and target look consistent (row counts).`);
        }
      }
    } catch {}
  }, { timezone: cfg.cron.tz });
}

scheduleAll().catch((err) => {
  log.error({ err }, "Fatal error in scheduler.");
  process.exit(1);
});
