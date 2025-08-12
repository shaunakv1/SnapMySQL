import { cfg } from "./config.js";
import { tableCounts } from "./mysql.js";
import { log } from "./logger.js";

export async function verifySourceVsTarget() {
  const srcCounts = await tableCounts({ conn: cfg.src, db: cfg.src.db });
  const tgtCounts = await tableCounts({ conn: cfg.tgt, db: cfg.tgt.db });

  const srcTables = new Set([...srcCounts.keys()]);
  const tgtTables = new Set([...tgtCounts.keys()]);

  const missingInTgt = [...srcTables].filter(t => !tgtTables.has(t));
  const extraInTgt   = [...tgtTables].filter(t => !srcTables.has(t));

  const diffs = [];
  for (const t of srcTables) {
    const a = srcCounts.get(t);
    const b = tgtCounts.get(t);
    if (b === undefined) continue;
    if (a !== b) diffs.push({ table: t, src: a, tgt: b });
  }

  return { missingInTgt, extraInTgt, diffs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifySourceVsTarget().then((r) => {
    log.info(r, "Verification results");
    if (r.missingInTgt.length || r.extraInTgt.length || r.diffs.length) process.exit(2);
  });
}
