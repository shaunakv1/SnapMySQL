import cron from "node-cron";
import { cfg } from "./config.js";
import { mkLogger, newRid } from "./logger.js";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";

const log = mkLogger("main");

log.info("SCHED_START", { backup: cfg.cron.backup, restore: cfg.cron.restore, tz: cfg.cron.tz });

cron.schedule(cfg.cron.backup, async () => {
  const rid = newRid("b");
  log.info("B_CRON", { rid });
  try { await runBackup(rid); } catch {}
}, { timezone: cfg.cron.tz });

cron.schedule(cfg.cron.restore, async () => {
  const rid = newRid("r");
  log.info("R_CRON", { rid });
  try { await runRestore(rid); } catch {}
}, { timezone: cfg.cron.tz });
