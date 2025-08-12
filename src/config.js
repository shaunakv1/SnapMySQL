export const cfg = {
  src: {
    host: process.env.SRC_DB_HOST,
    port: Number(process.env.SRC_DB_PORT || 3306),
    user: process.env.SRC_DB_USER,
    pass: process.env.SRC_DB_PASSWORD,
    db: process.env.SRC_DB_NAME
  },
  tgt: {
    host: process.env.TGT_DB_HOST,
    port: Number(process.env.TGT_DB_PORT || 3306),
    user: process.env.TGT_DB_USER,
    pass: process.env.TGT_DB_PASSWORD,
    db: process.env.TGT_DB_NAME
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  },
  cron: {
    backup: process.env.CRON_BACKUP || "0 3 * * *",
    restore: process.env.CRON_RESTORE || "30 3 * * *",
    tz: process.env.TZ || "UTC"
  },
  slackWebhook: process.env.SLACK_WEBHOOK_URL || "",
  verifyAfterRestore: (process.env.VERIFY_AFTER_RESTORE || "false").toLowerCase() === "true",
  keepLocalWorkdir: (process.env.KEEP_LOCAL_WORKDIR || "false").toLowerCase() === "true"
};

export function requireEnv() {
  const missing = [];
  const req = [
    "SRC_DB_HOST","SRC_DB_USER","SRC_DB_PASSWORD","SRC_DB_NAME",
    "TGT_DB_HOST","TGT_DB_USER","TGT_DB_PASSWORD","TGT_DB_NAME",
    "S3_ENDPOINT","S3_BUCKET","S3_ACCESS_KEY_ID","S3_SECRET_ACCESS_KEY"
  ];
  for (const key of req) if (!process.env[key]) missing.push(key);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
