import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyEvent,
  buildEventImpacts,
  detectThemes,
  detectPolicy,
  extractMetrics,
  timeDecay,
  classifyCategory
} from "../lib/events.js";

test("policy headlines are categorised and detected", () => {
  const event = classifyEvent({ title: "国务院常务会议部署新一轮大规模设备更新和消费品以旧换新" });
  assert.equal(event.category, "政策");
  assert.ok(event.policy.length > 0);
  assert.equal(event.sentiment, "positive");
  assert.ok(event.magnitude > 0);
});

test("positive announcements score positive and carry a magnitude", () => {
  const event = classifyEvent({ title: "某半导体设备公司公告：中标12.6亿元先进制程光刻设备订单" });
  assert.equal(event.sentiment, "positive");
  assert.ok(event.sentimentScore >= 3);
  assert.ok(event.themes.some((t) => t.theme === "半导体"));
  assert.equal(event.metrics.amount, 12.6e8);
});

test("loss warnings score strongly negative", () => {
  const event = classifyEvent({ title: "*ST某某：2025年年度业绩预告净利润同比下降320%" });
  assert.equal(event.sentiment, "negative");
  assert.ok(event.sentimentScore <= -3);
  assert.ok(event.metrics.growthPct < 0);
  assert.equal(event.category, "财报");
});

test("monetary policy is recognised as a policy event", () => {
  const event = classifyEvent({ title: "央行宣布降准0.5个百分点，释放长期资金约1万亿元" });
  assert.equal(event.category, "政策");
  assert.ok(event.policy.includes("央行"));
  assert.ok(event.policy.includes("降准"));
});

test("theme detection is ranked by keyword hits", () => {
  const themes = detectThemes("光伏组件价格上涨，硅料和电池片同步涨价，逆变器需求回暖");
  assert.equal(themes[0].theme, "光伏");
  assert.ok(themes[0].matched.length >= 3);
});

test("policy detection finds regulators and tools", () => {
  assert.deepEqual(detectPolicy("证监会发布并购重组新规").sort(), ["证监会"]);
  assert.equal(classifyCategory("美联储议息会议纪要公布"), "宏观");
});

test("extractMetrics reads percentages and amounts", () => {
  assert.equal(extractMetrics("营业收入同比增长11.2%").growthPct, 11.2);
  assert.equal(extractMetrics("净利润同比下降30%").growthPct, -30);
  assert.equal(extractMetrics("签署8.4亿元合同").amount, 8.4e8);
  assert.equal(extractMetrics("中标金额3200万元").amount, 3200e4);
  assert.deepEqual(extractMetrics("无数字"), {});
});

test("timeDecay halves at the half-life", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.ok(Math.abs(timeDecay("2026-01-02T00:00:00Z", now, 18) - 1) < 1e-6);
  assert.ok(Math.abs(timeDecay("2026-01-01T06:00:00Z", now, 18) - 0.5) < 1e-6);
  assert.ok(timeDecay("2026-01-01T00:00:00Z", now, 18) < 0.5);
  // A timestamp in the future must not blow up past 1.
  assert.equal(timeDecay("2026-01-03T00:00:00Z", now, 18), 1);
});

test("events propagate to directly named stocks and to theme members", () => {
  const stocks = [
    { code: "600519", name: "贵州茅台", industry: "白酒食品" },
    { code: "688981", name: "中芯国际", industry: "半导体" },
    { code: "000001", name: "平安银行", industry: "银行" }
  ];
  const themeIndex = new Map([
    ["半导体", ["688981"]],
    ["白酒食品", ["600519"]],
    ["银行", ["000001"]]
  ]);
  const result = buildEventImpacts(
    [
      { title: "半导体设备国产替代加速，中芯国际宣布扩产", publishedAt: new Date().toISOString(), source: "test" },
      { title: "贵州茅台：2025年半年报营业收入同比增长11.2%，净利润同比增长10.5%", publishedAt: new Date().toISOString(), source: "test" }
    ],
    stocks,
    { themeIndex }
  );

  const chip = result.impacts.get("688981");
  assert.ok(chip, "中芯国际 should receive an impact");
  assert.ok(chip.eventBias > 0, "the semiconductor news is positive");
  assert.ok(chip.items.some((item) => item.relevance === "direct"));

  const maotai = result.impacts.get("600519");
  assert.ok(maotai);
  assert.ok(maotai.eventBias > 0);
  assert.equal(result.impacts.has("000001"), false, "unrelated sector must stay clean");
});

test("negative events push the bias negative", () => {
  const stocks = [{ code: "300123", name: "*ST亚光", industry: "军工" }];
  const result = buildEventImpacts(
    [{ title: "*ST亚光因涉嫌信息披露违法违规被证监会立案调查，公司股票面临退市风险警示", publishedAt: new Date().toISOString(), source: "test" }],
    stocks,
    { themeIndex: new Map([["军工", ["300123"]]]) }
  );
  const impact = result.impacts.get("300123");
  assert.ok(impact);
  assert.ok(impact.eventBias < 0);
});

test("decay reduces the impact of stale headlines", () => {
  const stocks = [{ code: "600519", name: "贵州茅台", industry: "白酒食品" }];
  const themeIndex = new Map([["白酒食品", ["600519"]]]);
  const fresh = buildEventImpacts(
    [{ title: "白酒行业需求回暖，茅台宣布提价", publishedAt: new Date().toISOString(), source: "t" }],
    stocks,
    { themeIndex }
  ).impacts.get("600519").eventScore;
  const stale = buildEventImpacts(
    [{ title: "白酒行业需求回暖，茅台宣布提价", publishedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), source: "t" }],
    stocks,
    { themeIndex }
  ).impacts.get("600519").eventScore;
  assert.ok(Math.abs(stale) < Math.abs(fresh));
});
