import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";

/** Build common MySQL CLI options */
function commonMyOpts({ host, port, user, pass }) {
  const opts = ["-h", host, "-P", String(port), "-u", user, `-p${pass}`, "--protocol=TCP"];
  return opts;
}

/**
 * Create a full logical dump and gzip it to `outFile`.
 * Flags:
 *  --single-transaction --routines --events --triggers --hex-blob --set-gtid-purged=OFF --databases <db>
 */
export async function mysqldumpFull({ conn, db, outFile }) {
  if (!outFile) throw new Error("mysqldumpFull: outFile is required");
  const dumpArgs = [
    ...commonMyOpts(conn),
    "--single-transaction",
    "--routines",
    "--events",
    "--triggers",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--databases", db
  ];

  // Pipe mysqldump -> gzip -> file (no shell redirection)
  const gzip = execa("gzip", ["-c"], { stdout: "pipe", stdin: "pipe" });
  const dump = execa("mysqldump", dumpArgs, { stdout: "pipe" });

  // Create the output write stream
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const out = fs.createWriteStream(outFile);

  // Wire streams
  dump.stdout.pipe(gzip.stdin);
  gzip.stdout.pipe(out);

  // Await completion
  await Promise.all([dump, new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); }) , gzip]);
  return outFile;
}

/** Execute arbitrary SQL against a server (no DB required). */
async function mysqlExecSql({ conn, sql }) {
  const args = [...commonMyOpts(conn)];
  const child = execa("mysql", args, { input: sql });
  await child;
}

/** Kill all sessions connected to `db` (except our connection). */
export async function killDbConnections({ conn, db }) {
  const sql = `
    SET @me = CONNECTION_ID();
    SELECT CONCAT('KILL ', ID, ';') AS k
      FROM information_schema.PROCESSLIST
      WHERE db = '${db}' AND ID <> @me;
  `;
  // Fetch IDs then kill in a second call to avoid issues with multi-statements disabled
  const args = [...commonMyOpts(conn), "-N", "-e", sql];
  const { stdout } = await execa("mysql", args);
  const killStatements = stdout.split("\n").map(s => s.trim()).filter(Boolean).join("\n");
  if (killStatements) {
    await mysqlExecSql({ conn, sql: killStatements });
  }
}

/** Drop and recreate database cleanly. */
export async function dropAndRecreateDatabase({ conn, db }) {
  const sql = `
    DROP DATABASE IF EXISTS \`${db}\`;
    CREATE DATABASE \`${db}\`;
  `;
  await mysqlExecSql({ conn, sql });
}

/** Restore from a .sql.gz file into the target database. */
export async function restoreFromSqlGz({ conn, db, sqlGzPath }) {
  // Prepare mysql client connected to the target DB
  const args = [...commonMyOpts(conn), db];
  // gzip -dc file | mysql args
  const gunzip = execa("gzip", ["-dc", sqlGzPath], { stdout: "pipe" });
  const mysql = execa("mysql", args, { stdin: "pipe" });
  gunzip.stdout.pipe(mysql.stdin);
  await Promise.all([gunzip, mysql]);
}

/** Inventory tables & views and approximate row counts using information_schema */
export async function tableInventory({ conn, db }) {
  // Using information_schema avoids scanning tables
  const sql = `
    SELECT TABLE_NAME, TABLE_ROWS, TABLE_TYPE
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '${db}';
  `;
  const args = [...commonMyOpts(conn), "-N", "-e", sql];
  const { stdout } = await execa("mysql", args);

  const baseCounts = new Map();
  const views = new Set();
  stdout.split("\n").forEach(line => {
    if (!line) return;
    const [name, rowsStr, type] = line.split("\t");
    if (!name || !type) return;
    if (type === "BASE TABLE") {
      const n = parseInt(rowsStr || "0", 10);
      baseCounts.set(name, Number.isFinite(n) ? n : 0);
    } else if (type === "VIEW") {
      views.add(name);
    }
  });
  return { baseCounts, views };
}
