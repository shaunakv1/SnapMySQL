import cron from "node-cron";
import { cfg } from "./config.js";
import { mkLogger, newRid } from "./logger.js";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";

const log = mkLogger("main");

const ROLE = (process.env.ROLE || process.env.SNAP_ROLE || "both").toLowerCase(); // backup|restore|both
const PAUSE_BACKUP  = /^(1|true|yes)$/i.test(process.env.PAUSE_BACKUP || "");
const PAUSE_RESTORE = /^(1|true|yes)$/i.test(process.env.PAUSE_RESTORE || "");

log.info("SCHED_START", { role: ROLE, backup: cfg.cron.backup, restore: cfg.cron.restore, tz: cfg.cron.tz, pause_backup: PAUSE_BACKUP, pause_restore: PAUSE_RESTORE });

function paused(flagName) {
  const v = process.env[flagName];
  return /^(1|true|yes)$/i.test(v || "");
}

if (ROLE === "backup" || ROLE === "both") {
  cron.schedule(cfg.cron.backup, async () => {
    if (paused("PAUSE_BACKUP")) { log.warn("B_PAUSED", { reason: "PAUSE_BACKUP" }); return; }
    const rid = newRid("b");
    log.info("B_CRON", { rid });
    try { await runBackup(rid); } catch {}
  }, { timezone: cfg.cron.tz });
} else {
  log.info("SCHED_SKIP_BACKUP", { role: ROLE });
}

if (ROLE === "restore" || ROLE === "both") {
  cron.schedule(cfg.cron.restore, async () => {
    if (paused("PAUSE_RESTORE")) { log.warn("R_PAUSED", { reason: "PAUSE_RESTORE" }); return; }
    const rid = newRid("r");
    log.info("R_CRON", { rid });
    try { await runRestore(rid); } catch {}
  }, { timezone: cfg.cron.tz });
} else {
  log.info("SCHED_SKIP_RESTORE", { role: ROLE });
}
