import { mkLogger } from "./logger.js";

const log = mkLogger("notify");

export async function notifySlack(webhook, text, rid) {
  if (!webhook) {
    log.warn("N_SKIP", { rid, reason: "no-webhook" });
    return;
  }
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info("N_SENT", { rid, bytes: (text || "").length });
  } catch (err) {
    log.error("N_FAIL", { rid, err: (err && err.message) || String(err) });
  }
}
