// src/mysql.js
import { spawn } from "node:child_process";
import { createWriteStream, createReadStream, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { execa } from "execa";
import { mkLogger } from "./logger.js";

const log = mkLogger("mysql");

function resolvePassword(conn = {}) {
  const direct =
    conn.password ?? conn.pass ?? conn.pwd ?? conn.PASSWORD ?? conn.secret ?? null;
  if (direct) return String(direct);
  const envGuess =
    process.env.SRC_DB_PASSWORD ||
    process.env.TGT_DB_PASSWORD ||
    process.env.DB_PASSWORD ||
    null;
  return envGuess ? String(envGuess) : null;
}

function buildMysqlArgs(conn = {}) {
  const args = [];
  if (conn.host) args.push("-h", conn.host);
  if (conn.port) args.push("-P", String(conn.port));
  if (conn.user) args.push("-u", conn.user);
  const pw = resolvePassword(conn);
  if (pw) args.push(`--password=${pw}`);
  args.push("--protocol=TCP");
  return args;
}

function waitChild(child, name) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${name} exited with code ${code}`));
    });
  });
}

/**
 * Stream mysqldump -> gzip -> outFile (no Node buffering).
 */
export async function mysqldumpFull({ conn, db, outFile }) {
  if (!db) throw new Error("mysqldumpFull: db is required");
  if (!outFile) throw new Error("mysqldumpFull: outFile is required");

  await mkdir(dirname(outFile), { recursive: true });

  const dumpArgs = [
    ...buildMysqlArgs(conn),
    "--single-transaction",
    "--routines",
    "--events",
    "--triggers",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--databases",
    db,
  ];

  const child = spawn("mysqldump", dumpArgs, {
    stdio: ["ignore", "pipe", "inherit"],
  });

  // Pipe stdout -> gzip -> file; concurrently ensure child exits with code 0
  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(outFile)),
    waitChild(child, "mysqldump"),
  ]);

  const stat = await fs.stat(outFile);
  log.info("DUMP_DONE", { outFile, bytes: stat.size, host: conn?.host, db });
  return outFile;
}

/** Transform stream to strip DEFINER clauses from dump text. */
function stripDefinersTransform() {
  let leftover = "";
  return new Transform({
    decodeStrings: false,
    transform(chunk, enc, cb) {
      try {
        let text = leftover + chunk;
        const lines = text.split("\n");
        leftover = lines.pop() ?? "";
        const out = lines.map((line) =>
          line
            // Remove commented definers like: /*!50017 DEFINER=`user`@`host`*/
            .replace(/\/\*![0-9]{5}\s+DEFINER=`[^`]+`@`[^`]+`\s*\*\//g, "/* definer stripped */")
            // Remove inline definers like: CREATE ... DEFINER=`user`@`host` ...
            .replace(/\s*DEFINER=`[^`]+`@`[^`]+`\s*/g, " ")
        ).join("\n");
        cb(null, out);
      } catch (e) {
        cb(e);
      }
    },
    flush(cb) {
      try {
        if (leftover) {
          const line = leftover
            .replace(/\/\*![0-9]{5}\s+DEFINER=`[^`]+`@`[^`]+`\s*\*\//g, "/* definer stripped */")
            .replace(/\s*DEFINER=`[^`]+`@`[^`]+`\s*/g, " ");
          this.push(line);
        }
        cb();
      } catch (e) {
        cb(e);
      }
    },
  });
}

/**
 * Stream sql.gz -> gunzip -> strip DEFINER -> mysql (stdin).
 * Accepts sqlGz or sqlGzPath for compatibility with existing callers.
 */
export async function restoreFromSqlGz({ conn, db, sqlGz, sqlGzPath }) {
  if (!db) throw new Error("restoreFromSqlGz: db is required");
  const file = sqlGz || sqlGzPath;
  if (!file) throw new Error("restoreFromSqlGz: sqlGz is required");

  const mysqlArgs = [
    ...buildMysqlArgs(conn),
    "-D",
    db,
    // disable PK requirement at session scope if permitted by server
    "--init-command=SET SESSION sql_require_primary_key=0",
  ];

  const child = spawn("mysql", mysqlArgs, {
    stdio: ["pipe", "inherit", "inherit"],
  });

  await Promise.all([
    pipeline(createReadStream(file), createGunzip(), stripDefinersTransform(), child.stdin),
    waitChild(child, "mysql"),
  ]);

  log.info("RESTORE_STREAM_DONE", { sqlGz: file, db, host: conn?.host, stripDefiners: true });
}

export async function mysqlExecSql(conn, sql) {
  const args = [...buildMysqlArgs(conn), "-e", sql];
  await execa("mysql", args, { stdio: ["ignore", "inherit", "inherit"] });
}

export async function mysqlQueryText(conn, sql) {
  const args = [...buildMysqlArgs(conn), "--batch", "--raw", "-N", "-e", sql];
  const { stdout } = await execa("mysql", args, { stdout: "pipe", stderr: "inherit" });
  return stdout;
}

export async function killDbConnections(conn, db) {
  const dbName = db ?? conn?.database ?? conn?.db ?? null;
  if (!dbName) {
    log.warn("KILL_SKIP_NO_DB", { reason: "no-db-name" });
    return;
  }
  const safeDb = dbName.replace(/`/g, "``");
  const killSql =
    "SELECT CONCAT('KILL ',ID,';') FROM information_schema.PROCESSLIST " +
    `WHERE DB='${safeDb}' AND ID<>CONNECTION_ID();`;
  const { stdout } = await execa(
    "mysql",
    [...buildMysqlArgs(conn), "-N", "-B", "-e", killSql],
    { stdout: "pipe", stderr: "inherit" }
  );
  const stmts = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
  if (stmts) {
    await mysqlExecSql(conn, stmts);
  }
  log.info("KILLED_CONNS", { db: safeDb });
}

export async function dropAndRecreateDatabase(conn, db) {
  const safe = db.replace(/`/g, "``");
  const sql = `DROP DATABASE IF EXISTS \`${safe}\`; CREATE DATABASE \`${safe}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;`;
  await mysqlExecSql(conn, sql);
  log.info("DROP_CREATE_DB", { db });
}

export async function tableInventory(conn, db) {
  const safe = db.replace(/`/g, "``");
  const sql =
    "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES " +
    `WHERE TABLE_SCHEMA='${safe}' ORDER BY TABLE_NAME;`;
  const text = await mysqlQueryText(conn, sql);
  const tables = [];
  const views = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [name, type] = line.split("\t");
    if (type === "BASE TABLE") tables.push(name);
    else if (type === "VIEW") views.push(name);
  }
  return { tables, views };
}
