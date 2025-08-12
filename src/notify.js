import { log } from "./logger.js";

export async function notifySlack(webhookUrl, text) {
  if (!webhookUrl) {
    log.warn({ text }, "No SLACK_WEBHOOK_URL configured; skipping Slack notify.");
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Slack webhook failed: ${res.status} ${msg}`);
    }
  } catch (err) {
    log.error({ err }, "Slack notification failed.");
  }
}
