import { execa } from "execa";
import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";

function commonMyOpts({ host, port, user, pass }) {
  return [
    "-h", host,
    "-P", String(port),
    "-u", user,
    `-p${pass}`,
    "--protocol=TCP",
  ];
}

export async function mysqldumpFull({ conn, db, outDir }) {
  const sqlGz = path.join(outDir, `${db}.sql.gz`);
  const args = [
    ...commonMyOpts(conn),
    "--single-transaction",
    "--routines",
    "--events",
    "--triggers",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--databases", db,
  ];

  // Stream: mysqldump -> gzip -> file
  const dump = execa("mysqldump", args, { stdout: "pipe" });
  const gzip = execa("gzip", ["-c"], { input: dump.stdout, stdout: "pipe" });

  const writeStream = fs.createWriteStream(sqlGz);
  gzip.stdout.pipe(writeStream);

  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  log.info({ sqlGz }, "Created gzipped dump.");
  return sqlGz;
}

export async function mysqlExecSql({ conn, sql }) {
  const args = [
    ...commonMyOpts(conn),
    "-e", sql,
  ];
  await execa("mysql", args);
}

export async function killDbConnections({ conn, db }) {
  const sql = `
    SELECT CONCAT('KILL ', id, ';') AS cmd
    FROM information_schema.PROCESSLIST
    WHERE db='${db}';
  `;
  const args = [
    ...commonMyOpts(conn),
    "-N", "-e", sql,
  ];
  const { stdout } = await execa("mysql", args);
  const cmds = stdout.split("\n").map(s => s.trim()).filter(Boolean);
  if (cmds.length) {
    await mysqlExecSql({ conn, sql: cmds.join("\n") });
    log.info({ db }, `Killed ${cmds.length} connections.`);
  } else {
    log.info({ db }, "No connections to kill.");
  }
}

export async function listTables({ conn, db }) {
  const args = [
    ...commonMyOpts(conn),
    "-N",
    "-e",
    `SELECT table_name FROM information_schema.tables WHERE table_schema='${db}';`,
  ];
  const { stdout } = await execa("mysql", args);
  return stdout.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function archiveExistingDatabase({ conn, db }) {
  const prevDb = `${db}_previous`;
  await mysqlExecSql({ conn, sql: `CREATE DATABASE IF NOT EXISTS \`${prevDb}\`;` });

  const tables = await listTables({ conn, db });
  if (tables.length) {
    await mysqlExecSql({ conn, sql: "SET FOREIGN_KEY_CHECKS=0;" });
    const renames = tables.map(t =>
      `RENAME TABLE \`${db}\`.\`${t}\` TO \`${prevDb}\`.\`${t}\`;`
    ).join("\n");
    await mysqlExecSql({ conn, sql: renames });
    await mysqlExecSql({ conn, sql: "SET FOREIGN_KEY_CHECKS=1;" });
    log.info({ db, moved: tables.length }, "Archived tables to _previous.");
  } else {
    log.info({ db }, "No tables to archive.");
  }

  // Clean slate for routines/triggers/events too.
  await mysqlExecSql({ conn, sql: `DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`;` });
}

export async function restoreFromSqlGz({ conn, db, sqlGzPath }) {
  // gunzip -> mysql
  const gunzip = execa("gunzip", ["-c", sqlGzPath], { stdout: "pipe" });
  const args = [
    ...commonMyOpts(conn),
  ];
  const mysqlProc = execa("mysql", args, { input: gunzip.stdout });
  await mysqlProc;
  log.info({ db }, "Restore completed.");
}

/**
 * Legacy helper (approximate counts; includes views as NULL).
 * Kept for compatibility but superseded by tableInventory() below.
 */
export async function tableCounts({ conn, db }) {
  const args = [
    ...commonMyOpts(conn),
    "-N",
    "-e",
    `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema='${db}';`,
  ];
  const { stdout } = await execa("mysql", args);
  const map = new Map();
  stdout.split("\n").forEach(line => {
    if (!line) return;
    const [name, rowsStr] = line.split("\t");
    if (name) map.set(name, Number(rowsStr || 0));
  });
  return map;
}

/**
 * Preferred inventory: separates BASE TABLES from VIEWS and returns
 * approximate row counts only for BASE TABLES. Views are tracked by name.
 */
export async function tableInventory({ conn, db }) {
  const args = [
    ...commonMyOpts(conn),
    "-N",
    "-e",
    `SELECT table_name, IFNULL(table_rows,0), table_type
     FROM information_schema.tables
     WHERE table_schema='${db}';`,
  ];
  const { stdout } = await execa("mysql", args);
  const baseCounts = new Map(); // table -> approx row count
  const views = new Set();      // view names
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
