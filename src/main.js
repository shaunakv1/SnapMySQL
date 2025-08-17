import cron from "node-cron";
import { cfg } from "./config.js";
import { mkLogger, newRid } from "./logger.js";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";

const log = mkLogger("main");

const ROLE = (process.env.ROLE || process.env.SNAP_ROLE || "both").toLowerCase(); // backup|restore|both

const PAUSE_BACKUP  = /^(1|true|yes)$/i.test(process.env.PAUSE_BACKUP || "");
const PAUSE_RESTORE = /^(1|true|yes)$/i.test(process.env.PAUSE_RESTORE || "");

// When true, do not register cron schedules (useful for one-off tests)
const SKIP_CRON = /^(1|true|yes)$/i.test(process.env.SKIP_CRON || "");

// RUN_IMMEDIATELY: run once at startup without waiting for cron
// Accepts: true|1|yes (means "for current ROLE"), or 'backup' | 'restore' | 'both'
const RUN_IMMEDIATELY_RAW = (process.env.RUN_IMMEDIATELY || "").toLowerCase();
const RUN_IMMEDIATELY_BOOL = /^(1|true|yes)$/i.test(process.env.RUN_IMMEDIATELY || "");

// Prevent overlapping runs
let backupRunning = false;
let restoreRunning = false;

async function runBackupLocked(trigger = "cron") {
  if (backupRunning) { log.warn("B_SKIP_BUSY", { trigger }); return; }
  backupRunning = true;
  const rid = newRid("b");
  try { log.info(trigger === "immediate" ? "B_IMMEDIATE" : "B_CRON", { rid }); await runBackup(rid); }
  finally { backupRunning = false; }
}

async function runRestoreLocked(trigger = "cron") {
  if (restoreRunning) { log.warn("R_SKIP_BUSY", { trigger }); return; }
  restoreRunning = true;
  const rid = newRid("r");
  try { log.info(trigger === "immediate" ? "R_IMMEDIATE" : "R_CRON", { rid }); await runRestore(rid); }
  finally { restoreRunning = false; }
}

// Allowed tasks derived from ROLE
const allowed = new Set(ROLE === "both" ? ["backup","restore"] : [ROLE]);

function parseImmediateSet() {
  if (!RUN_IMMEDIATELY_RAW && !RUN_IMMEDIATELY_BOOL) return new Set();
  if (RUN_IMMEDIATELY_BOOL) return new Set(allowed); // respect ROLE
  if (RUN_IMMEDIATELY_RAW === "both") return new Set(["backup","restore"]);
  if (RUN_IMMEDIATELY_RAW === "backup" || RUN_IMMEDIATELY_RAW === "restore") return new Set([RUN_IMMEDIATELY_RAW]);
  return new Set(); // ignore unknown
}

const requestedImmediate = parseImmediateSet();
const immediateToRun = new Set([...requestedImmediate].filter(x => allowed.has(x)));
for (const x of requestedImmediate) {
  if (!allowed.has(x)) log.warn("IMMEDIATE_SKIP_ROLE", { requested: x, role: ROLE });
}

log.info("SCHED_START", {
  role: ROLE,
  backup: cfg.cron.backup,
  restore: cfg.cron.restore,
  tz: cfg.cron.tz,
  pause_backup: PAUSE_BACKUP,
  pause_restore: PAUSE_RESTORE,
  skip_cron: SKIP_CRON,
  run_immediately: RUN_IMMEDIATELY_RAW || (RUN_IMMEDIATELY_BOOL ? "role" : "")
});

// Immediate runs at startup (respect ROLE)
if (immediateToRun.has("backup")) runBackupLocked("immediate");
if (immediateToRun.has("restore")) runRestoreLocked("immediate");

// Optionally skip cron scheduling entirely
if (!SKIP_CRON) {
  if (ROLE === "backup" || ROLE === "both") {
    cron.schedule(cfg.cron.backup, async () => {
      if (/^(1|true|yes)$/i.test(process.env.PAUSE_BACKUP || "")) { log.warn("B_PAUSED", { reason: "PAUSE_BACKUP" }); return; }
      await runBackupLocked("cron");
    }, { timezone: cfg.cron.tz });
  } else {
    log.info("SCHED_SKIP_BACKUP", { role: ROLE });
  }

  if (ROLE === "restore" || ROLE === "both") {
    cron.schedule(cfg.cron.restore, async () => {
      if (/^(1|true|yes)$/i.test(process.env.PAUSE_RESTORE || "")) { log.warn("R_PAUSED", { reason: "PAUSE_RESTORE" }); return; }
      await runRestoreLocked("cron");
    }, { timezone: cfg.cron.tz });
  } else {
    log.info("SCHED_SKIP_RESTORE", { role: ROLE });
  }
} else {
  log.info("SCHED_DISABLED", { reason: "SKIP_CRON" });
}
