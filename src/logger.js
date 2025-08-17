import process from "node:process";

const LVL = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" };

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function fmtVal(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v.replace(/\s+/g, " ");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function line(level, event, ctx) {
  const kv = Object.entries(ctx || {}).map(([k, v]) => `${k}=${fmtVal(v)}`).join(" ");
  // Fixed-width tag for easy grepping
  console.log(`${ts()} [${LVL[level].padEnd(5)}] ${event.padEnd(7)} ${kv}`);
}

export function mkLogger(tag) {
  return {
    debug(event, ctx) { line("debug", event, { tag, ...(ctx||{}) }); },
    info (event, ctx) { line("info",  event, { tag, ...(ctx||{}) }); },
    warn (event, ctx) { line("warn",  event, { tag, ...(ctx||{}) }); },
    error(event, errOrCtx) {
      let ctx;
      if (errOrCtx instanceof Error) {
        ctx = { err: errOrCtx.message };
      } else if (typeof errOrCtx === "string") {
        ctx = { msg: errOrCtx };
      } else {
        ctx = { ...(errOrCtx||{}) };
      }
      line("error", event, { tag, ...ctx });
    }
  };
}

export function newRid(prefix = "r") {
  const t = Date.now().toString(36).slice(-6);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}${t}${r}`;
}
