import { cfg } from "./config.js";
import { tableInventory } from "./mysql.js";
import { log } from "./logger.js";

export async function verifySourceVsTarget() {
  const src = await tableInventory({ conn: cfg.src, db: cfg.src.db });
  const tgt = await tableInventory({ conn: cfg.tgt, db: cfg.tgt.db });

  // Presence check across both base tables and views.
  const srcObjects = new Set([...src.baseCounts.keys(), ...src.views]);
  const tgtObjects = new Set([...tgt.baseCounts.keys(), ...tgt.views]);

  const missingInTgt = [...srcObjects].filter(x => !tgtObjects.has(x));
  const extraInTgt = [...tgtObjects].filter(x => !srcObjects.has(x));

  // Row-count diffs only for BASE TABLES (skip views).
  const diffs = [];
  for (const t of src.baseCounts.keys()) {
    const a = src.baseCounts.get(t);
    const b = tgt.baseCounts.get(t);
    if (b === undefined) continue; // handled by presence check
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
