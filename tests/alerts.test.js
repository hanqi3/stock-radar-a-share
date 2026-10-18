import assert from "node:assert/strict";
import test from "node:test";

import { ALERT_LIMIT, buildAlerts, formatAlerts } from "../lib/alerts.js";

function macroItem(symbol, name, value, changeBp, changePct) {
  return {
    symbol,
    name,
    value,
    changeBp: Number.isFinite(changeBp) ? changeBp : null,
    changePct: Number.isFinite(changePct) ? changePct : null
  };
}

function indexItem(name, price, changePct) {
  return { name, price, changePct };
}

test("a quiet night produces no banner at all", () => {
  const alerts = buildAlerts({
    macro: { items: [macroItem("us10y", "美债10年期", 5.1, 1, -0.2)] },
    indices: { items: [indexItem("纳斯达克", 20000, 0.3)] }
  });
  assert.deepEqual(alerts, []);
});

test("an empty payload does not throw", () => {
  assert.deepEqual(buildAlerts({}), []);
  assert.deepEqual(buildAlerts({ macro: null, indices: null }), []);
});

test("the fed decision outranks everything else", () => {
  const alerts = buildAlerts({
    macro: {
      items: [
        macroItem("fedfunds", "联邦基金利率", 4.25, -25, null),
        macroItem("us10y", "美债10年期", 5.1, -9, -1.73)
      ]
    },
    indices: { items: [indexItem("费城半导体", 11137.29, -3.83)] }
  });
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].key, "fed");
  assert.match(alerts[0].title, /美联储利率 下调 25bp/);
  assert.equal(alerts[1].key, "us10y");
});

test("severity plus magnitude decides the cut-off", () => {
  const alerts = buildAlerts({
    macro: { items: [] },
    indices: {
      items: [
        indexItem("纳斯达克", 22300, -1.6),
        indexItem("费城半导体", 11137, -3.2),
        indexItem("布伦特原油", 88.4, 3.1),
        indexItem("美元指数", 101.7, 1.2)
      ]
    },
    limit: 2
  });
  assert.equal(alerts.length, 2);
  // sox 55+3.2 beats nasdaq 50+1.6, brent 45+3.1 and dxy 40+1.2
  assert.deepEqual(
    alerts.map((alert) => alert.key),
    ["sox", "nasdaq"]
  );
});

test("each alert carries a tone and a detail line", () => {
  const alerts = buildAlerts({
    macro: { items: [macroItem("us10y", "美债10年期", 5.1, -9, -1.73)] },
    indices: { items: [indexItem("费城半导体", 11137.29, -3.83)] }
  });
  for (const alert of alerts) {
    assert.ok(["positive", "negative", "neutral"].includes(alert.tone), alert.tone);
    assert.ok(alert.title.length > 0);
    assert.ok(alert.detail.length > 0);
  }
});

test("the digest summary lists the moves on one line", () => {
  const alerts = buildAlerts({
    macro: { items: [macroItem("us10y", "美债10年期", 5.1, -9, -1.73)] },
    indices: { items: [indexItem("费城半导体", 11137.29, -3.83)] }
  });
  const summary = formatAlerts(alerts, "2026-10-19");
  assert.match(summary, /^【2026-10-19 隔夜宏观】/);
  assert.match(summary, /10年期美债/);
  assert.match(summary, /费城半导体/);
  assert.ok(!summary.includes("\n"));
});

test("formatting an empty list says nothing rather than crashing", () => {
  const summary = formatAlerts([], "2026-10-19");
  assert.equal(typeof summary, "string");
  assert.equal(summary, "");
});

test("the default cap stays small enough for one banner line", () => {
  assert.equal(ALERT_LIMIT, 3);
});
