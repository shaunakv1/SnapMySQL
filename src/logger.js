import process from "node:process";

const LVL = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" };

function ts() {
  // 2025-08-13 03:20:00Z (no millis)
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function fmtVal(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v.replace(/\s+/g, " ");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Flatten simple objects/arrays to JSON without spaces
  try { return JSON.stringify(v); } catch { return String(v); }
}

function padRight(s, n) {
  return (s + " ".repeat(n)).slice(0, n);
}

export function mkLogger(component = "app") {
  const comp = padRight(component, 7);
  function line(level, event, ctx = {}) {
    const kvs = [];
    for (const [k, v] of Object.entries(ctx)) {
      if (v === undefined) continue;
      kvs.push(`${k}=${fmtVal(v)}`);
    }
    const out = `${ts()} [${LVL[level]||"INFO"}] ${comp} ${event}${kvs.length ? " " + kvs.join(" ") : ""}`;
    if (level === "error") {
      console.error(out);
      if (process.env.LOG_STACK === "true" && ctx.err_stack) console.error(ctx.err_stack);
    } else {
      console.log(out);
    }
  }
  return {
    debug: (event, ctx) => line("debug", event, ctx),
    info:  (event, ctx) => line("info",  event, ctx),
    warn:  (event, ctx) => line("warn",  event, ctx),
    error: (event, errOrCtx, maybeCtx) => {
      let ctx = {};
      if (errOrCtx instanceof Error) {
        ctx = { err: errOrCtx.message, err_stack: errOrCtx.stack, ...(maybeCtx||{}) };
      } else {
        ctx = { ...(errOrCtx||{}) };
      }
      line("error", event, ctx);
    }
  };
}

// simple request/cycle id
export function newRid(prefix = "r") {
  const t = Date.now().toString(36).slice(-6);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}${t}${r}`;
}
