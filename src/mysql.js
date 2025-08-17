
// src/mysql.js
import { spawn } from "node:child_process";
import { createWriteStream, createReadStream, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { execa } from "execa";
import { log } from "./logger.js";

function buildMysqlArgs(conn) {
  const args = [];
  if (conn.host) args.push("-h", conn.host);
  if (conn.port) args.push("-P", String(conn.port));
  if (conn.user) args.push("-u", conn.user);
  if (conn.password) args.push(`-p${conn.password}`);
  args.push("--protocol=TCP");
  return args;
}

/**
 * Stream mysqldump -> gzip -> outFile without buffering in Node.
 * Avoids execa's default 100MB maxBuffer.
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

  await new Promise((resolve, reject) => {
    const gzip = createGzip();
    const out = createWriteStream(outFile);
    const child = spawn("mysqldump", dumpArgs, {
      stdio: ["ignore", "pipe", "inherit"], // don't buffer stdout; we consume it
    });

    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      // Best-effort kill
      try { child.kill("SIGKILL"); } catch {}
      reject(err);
    };
    const ok = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    child.on("error", fail);
    out.on("error", fail);
    gzip.on("error", fail);

    child.stdout.pipe(gzip).pipe(out);

    child.on("close", (code) => {
      if (code === 0) {
        // wait for file stream to finish flushing
        out.on("close", ok);
        out.end();
      } else {
        fail(new Error(`mysqldump exited with code ${code}`));
      }
    });
  });

  const stat = await fs.stat(outFile);
  log.info("DUMP_DONE", { outFile, bytes: stat.size });
  return outFile;
}

export async function restoreFromSqlGz({ conn, db, sqlGz }) {
  if (!db) throw new Error("restoreFromSqlGz: db is required");
  if (!sqlGz) throw new Error("restoreFromSqlGz: sqlGz is required");

  await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const child = spawn("mysql", [...buildMysqlArgs(conn), "-D", db], {
      stdio: ["pipe", "inherit", "inherit"],
    });

    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(err);
    };
    const ok = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    child.on("error", fail);
    gunzip.on("error", fail);

    const rs = createReadStream(sqlGz);
    rs.on("error", fail);
    rs.pipe(gunzip).pipe(child.stdin);

    child.on("close", (code) => {
      if (code === 0) ok();
      else fail(new Error(`mysql exited with code ${code}`));
    });
  });

  log.info("RESTORE_STREAM_DONE", { sqlGz, db });
}

export async function mysqlExecSql(conn, sql) {
  const args = [...buildMysqlArgs(conn), "-e", sql];
  await execa("mysql", args, { stdio: ["ignore", "inherit", "inherit"] });
}

export async function mysqlQueryText(conn, sql) {
  // Return raw text rows with no headers
  const args = [...buildMysqlArgs(conn), "--batch", "--raw", "-N", "-e", sql];
  const { stdout } = await execa("mysql", args, { stdout: "pipe", stderr: "inherit" });
  return stdout;
}

export async function killDbConnections(conn, db) {
  // Generate KILL statements and execute in one shot
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
