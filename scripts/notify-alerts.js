#!/usr/bin/env node
// Pushes the 异动信号 digest to a chat webhook.
//
// The digest is written by the dashboard when /api/briefing is served (a
// scheduled run does this via the API smoke test), so this script only has to
// format and deliver it. Without a webhook configured it prints the message and
// exits 0 — a repo should not fail just because nobody wired a bot to it.
//
// Environment:
//   ALERT_WEBHOOK_URL     required to actually send
//   ALERT_WEBHOOK_FORMAT  wecom (default) | feishu | json
//
// Usage: node scripts/notify-alerts.js [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatDigest } from "../lib/alert-digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIGEST_FILE = path.join(__dirname, "..", "data", "alert-digest.json");

const dryRun = process.argv.includes("--dry-run");

function payloadFor(format, text) {
  if (format === "feishu") return { msg_type: "text", content: { text } };
  if (format === "json") return { text };
  // 企业微信群机器人
  return { msgtype: "text", text: { content: text } };
}

async function main() {
  const store = JSON.parse(await fs.readFile(DIGEST_FILE, "utf8"));
  const text = formatDigest(store);
  if (!text) {
    console.log("Alert digest is empty; nothing to send.");
    return;
  }

  const url = String(process.env.ALERT_WEBHOOK_URL || "").trim();
  const format = String(process.env.ALERT_WEBHOOK_FORMAT || "wecom").trim().toLowerCase();
  console.log(text);

  if (!url) {
    console.log("\n(no ALERT_WEBHOOK_URL set — printed only, nothing was sent)");
    return;
  }
  if (dryRun) {
    console.log(`\n--dry-run: would POST ${format} payload to the configured webhook`);
    return;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloadFor(format, text))
  });
  const reply = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`webhook responded ${response.status}: ${reply.slice(0, 200)}`);
  }
  // Chat bots answer 200 with an error code in the body, which is worth surfacing.
  if (/"errcode"\s*:\s*(?!0)\d+/.test(reply) || /"code"\s*:\s*(?!0)\d+/.test(reply)) {
    throw new Error(`webhook rejected the message: ${reply.slice(0, 200)}`);
  }
  console.log(`\nSent to webhook (${format}) — ${response.status}`);
}

await main();
