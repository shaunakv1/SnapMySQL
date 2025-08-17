import process from "node:process";

function getEnv(name, defVal = undefined) {
  const v = process.env[name];
  return (v === undefined || v === null || v === "") ? defVal : v;
}

// Strip inline comments starting with '#' and collapse whitespace.
function sanitizeCron(expr) {
  if (!expr) return expr;
  const cleaned = expr.split("#")[0].trim().replace(/\s+/g, " ");
  return cleaned;
}

function must(name, val, missing) {
  if (val === undefined || val === null || String(val).trim() === "") {
    missing.push(name);
  }
  return val;
}

const SRC_DB_PASS = getEnv("SRC_DB_PASS", getEnv("SRC_DB_PASSWORD"));
const TGT_DB_PASS = getEnv("TGT_DB_PASS", getEnv("TGT_DB_PASSWORD"));

// Timezone: prefer CRON_TZ, fallback TZ, default UTC
const CRON_TZ = getEnv("CRON_TZ", getEnv("TZ", "UTC"));

const CRON_BACKUP = sanitizeCron(getEnv("CRON_BACKUP", "0 * * * *"));     // default hourly
const CRON_RESTORE = sanitizeCron(getEnv("CRON_RESTORE", "5 * * * *"));   // default hourly at :05

export const cfg = {
  src: {
    host: getEnv("SRC_DB_HOST"),
    port: Number(getEnv("SRC_DB_PORT", "3306")),
    user: getEnv("SRC_DB_USER"),
    pass: SRC_DB_PASS,
    db:   getEnv("SRC_DB_NAME")
  },
  tgt: {
    host: getEnv("TGT_DB_HOST"),
    port: Number(getEnv("TGT_DB_PORT", "3306")),
    user: getEnv("TGT_DB_USER", "root"),
    pass: TGT_DB_PASS ?? "",
    db:   getEnv("TGT_DB_NAME", getEnv("SRC_DB_NAME"))
  },
  s3: {
    endpoint: getEnv("S3_ENDPOINT"),
    region:   getEnv("S3_REGION"),
    bucket:   getEnv("S3_BUCKET"),
    accessKeyId: getEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: getEnv("S3_SECRET_ACCESS_KEY")
  },
  cron: {
    backup: CRON_BACKUP,
    restore: CRON_RESTORE,
    tz: CRON_TZ
  },
  slackWebhook: getEnv("SLACK_WEBHOOK_URL", ""),
  keepLocalWorkdir: /^true|1|yes$/i.test(getEnv("KEEP_LOCAL_WORKDIR", "")),
  verifyAfterRestore: /^true|1|yes$/i.test(getEnv("VERIFY_AFTER_RESTORE", ""))
};

/** Validate only what's needed for a BACKUP */
export function requireBackupEnv() {
  const missing = [];
  must("SRC_DB_HOST", cfg.src.host, missing);
  must("SRC_DB_USER", cfg.src.user, missing);
  must("SRC_DB_PASS", cfg.src.pass, missing);
  must("SRC_DB_NAME", cfg.src.db, missing);
  must("S3_ENDPOINT", cfg.s3.endpoint, missing);
  must("S3_REGION", cfg.s3.region, missing);
  must("S3_BUCKET", cfg.s3.bucket, missing);
  must("S3_ACCESS_KEY_ID", cfg.s3.accessKeyId, missing);
  must("S3_SECRET_ACCESS_KEY", cfg.s3.secretAccessKey, missing);
  if (missing.length) {
    throw new Error(`Missing required env vars (backup): ${missing.join(", ")}`);
  }
  return true;
}

/** Validate superset needed for a RESTORE */
export function requireRestoreEnv() {
  const missing = [];
  // backup requirements first (we often do a pre-restore verification/backup)
  must("SRC_DB_HOST", cfg.src.host, missing);
  must("SRC_DB_USER", cfg.src.user, missing);
  must("SRC_DB_PASS", cfg.src.pass, missing);
  must("SRC_DB_NAME", cfg.src.db, missing);
  must("S3_ENDPOINT", cfg.s3.endpoint, missing);
  must("S3_REGION", cfg.s3.region, missing);
  must("S3_BUCKET", cfg.s3.bucket, missing);
  must("S3_ACCESS_KEY_ID", cfg.s3.accessKeyId, missing);
  must("S3_SECRET_ACCESS_KEY", cfg.s3.secretAccessKey, missing);
  // target requirements
  must("TGT_DB_HOST", cfg.tgt.host, missing);
  must("TGT_DB_USER", cfg.tgt.user, missing);
  must("TGT_DB_PASS", cfg.tgt.pass, missing);
  // TGT_DB_NAME can default to SRC_DB_NAME; no must() needed
  if (missing.length) {
    throw new Error(`Missing required env vars (restore): ${missing.join(", ")}`);
  }
  return true;
}

/** Back-compat: auto-select validation based on ROLE */
export function requireEnv() {
  const role = (getEnv("ROLE", getEnv("SNAP_ROLE", "both")) || "both").toLowerCase();
  if (role === "backup") return requireBackupEnv();
  // 'restore' or 'both' validate restore superset
  return requireRestoreEnv();
}
