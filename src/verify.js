import { cfg } from "./config.js";
import { tableInventory } from "./mysql.js";
import { mkLogger, newRid } from "./logger.js";

const log = mkLogger("verify");

export async function verifySourceVsTarget(rid = newRid("v")) {
  const src = await tableInventory({ conn: cfg.src, db: cfg.src.db });
  const tgt = await tableInventory({ conn: cfg.tgt, db: cfg.tgt.db });

  const srcObjects = new Set([...src.baseCounts.keys(), ...src.views]);
  const tgtObjects = new Set([...tgt.baseCounts.keys(), ...tgt.views]);

  const missingInTgt = [...srcObjects].filter(x => !tgtObjects.has(x));
  const extraInTgt   = [...tgtObjects].filter(x => !srcObjects.has(x));

  const diffs = [];
  for (const [tbl, srcCount] of src.baseCounts.entries()) {
    const tgtCount = tgt.baseCounts.get(tbl);
    if (tgtCount !== undefined && srcCount !== tgtCount) {
      diffs.push({ table: tbl, src: srcCount, tgt: tgtCount });
    }
  }

  const ok = !(missingInTgt.length || extraInTgt.length || diffs.length);
  if (ok) log.info("V_OK", { rid, db: cfg.tgt.db, tables: src.baseCounts.size, views: src.views.size, diffs: 0 });
  else    log.warn("V_DIFFS", { rid, db: cfg.tgt.db, missing: missingInTgt.length, extra: extraInTgt.length, diffs: diffs.length });

  return { missingInTgt, extraInTgt, diffs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifySourceVsTarget().then((r) => {
    const ok = !(r.missingInTgt.length || r.extraInTgt.length || r.diffs.length);
    if (!ok) process.exit(2);
  });
}
