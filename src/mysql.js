
// src/mysql.js
import { spawn } from "node:child_process";
import { createWriteStream, createReadStream, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
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

/**
 * Stream sql.gz -> gunzip -> mysql (stdin).
 */
export async function restoreFromSqlGz({ conn, db, sqlGz }) {
  if (!db) throw new Error("restoreFromSqlGz: db is required");
  if (!sqlGz) throw new Error("restoreFromSqlGz: sqlGz is required");

  const child = spawn("mysql", [...buildMysqlArgs(conn), "-D", db], {
    stdio: ["pipe", "inherit", "inherit"],
  });

  await Promise.all([
    pipeline(createReadStream(sqlGz), createGunzip(), child.stdin),
    waitChild(child, "mysql"),
  ]);

  log.info("RESTORE_STREAM_DONE", { sqlGz, db, host: conn?.host });
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
  const killSql =
    "SELECT CONCAT('KILL ',ID,';') FROM information_schema.PROCESSLIST " +
    `WHERE DB='${db.replace(/`/g, "``")}' AND ID<>CONNECTION_ID();`;
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
  log.info("KILLED_CONNS", { db });
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
