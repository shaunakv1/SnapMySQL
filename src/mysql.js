import { execa } from "execa";
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
  const dump = execa("mysqldump", args, { stdout: "pipe" });
  const gzip = execa("gzip", ["-c"], { input: dump.stdout, stdout: "pipe" });
  const writeStream = fs.createWriteStream(sqlGz);
  gzip.stdout.pipe(writeStream);
  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });
  return sqlGz;
}

export async function mysqlExecSql({ conn, sql }) {
  const args = [ ...commonMyOpts(conn), "-e", sql ];
  await execa("mysql", args);
}

export async function killDbConnections({ conn, db }) {
  const sql = `SELECT CONCAT('KILL ', id, ';') AS cmd FROM information_schema.PROCESSLIST WHERE db='${db}';`;
  const args = [ ...commonMyOpts(conn), "-N", "-e", sql ];
  const { stdout } = await execa("mysql", args);
  const cmds = stdout.split("\n").map(s => s.trim()).filter(Boolean);
  if (cmds.length) await mysqlExecSql({ conn, sql: cmds.join("\n") });
}

export async function dropAndRecreateDatabase({ conn, db }) {
  await mysqlExecSql({ conn, sql: `DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`;` });
}

export async function restoreFromSqlGz({ conn, db, sqlGzPath }) {
  const gunzip = execa("gunzip", ["-c", sqlGzPath], { stdout: "pipe" });
  const args = [ ...commonMyOpts(conn) ];
  const mysqlProc = execa("mysql", args, { input: gunzip.stdout });
  await mysqlProc;
}

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
