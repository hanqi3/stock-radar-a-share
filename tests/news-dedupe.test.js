import assert from "node:assert/strict";
import test from "node:test";

import { dedupeEvents, eventTitleKey } from "../scripts/sync-news.js";

const event = (overrides) => ({
  id: `id-${Math.random().toString(16).slice(2)}`,
  title: "某公司发布三季度业绩预告",
  summary: "summary",
  source: "新浪财经7x24·公司",
  publishedAt: "2026-10-15T10:00:00.000Z",
  codes: [],
  ...overrides
});

test("eventTitleKey ignores punctuation and spacing", () => {
  assert.equal(
    eventTitleKey("金融街论坛明日开幕！潘功胜、丁向群、吴清将作主题演讲"),
    eventTitleKey("金融街论坛明日开幕 潘功胜、丁向群、吴清将作主题演讲")
  );
  assert.equal(eventTitleKey("埃及考虑支援沙特 仅限“防御”"), eventTitleKey("埃及考虑支援沙特 仅限“防御” "));
});

test("eventTitleKey drops a trailing outlet attribution", () => {
  assert.equal(eventTitleKey("沪指收涨1.2% - 新浪财经"), eventTitleKey("沪指收涨1.2%"));
});

test("eventTitleKey refuses to key very short titles", () => {
  assert.equal(eventTitleKey("公告"), "");
  assert.equal(eventTitleKey(""), "");
  assert.equal(eventTitleKey(null), "");
});

test("the same story from two feeds collapses into one item", () => {
  const out = dedupeEvents([
    event({ title: "东海证券：预计10月美联储暂停加息", source: "东方财富快讯·美国·美联储" }),
    event({ title: "东海证券: 预计10月美联储暂停加息!", source: "新浪财经7x24·国际" })
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].alsoIn, ["新浪财经7x24"]);
});

test("the same feed under two tags is merged without an alsoIn note", () => {
  const out = dedupeEvents([
    event({ title: "央行开展5000亿元MLF操作", source: "新浪财经7x24·政策" }),
    event({ title: "央行开展5000亿元MLF操作", source: "新浪财经7x24·公司" })
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].alsoIn, undefined);
});

test("genuinely different stories both survive", () => {
  const out = dedupeEvents([
    event({ title: "央行开展5000亿元MLF操作" }),
    event({ title: "证监会就程序化交易新规公开征求意见" })
  ]);
  assert.equal(out.length, 2);
});

test("duplicate ids are dropped even when the titles differ", () => {
  const out = dedupeEvents([
    event({ id: "same", title: "第一条新闻标题内容" }),
    event({ id: "same", title: "另一条完全不同的标题" })
  ]);
  assert.equal(out.length, 1);
});

test("merging keeps the stock tags from every copy", () => {
  const out = dedupeEvents([
    event({ title: "宁德时代与某车企签订长期供货协议", codes: ["300750"] }),
    event({ title: "宁德时代与某车企签订长期供货协议", codes: ["600519"], source: "东方财富快讯" })
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].codes].sort(), ["300750", "600519"]);
});

test("merging keeps the earlier timestamp", () => {
  const out = dedupeEvents([
    event({ title: "国常会部署新一轮稳增长措施", publishedAt: "2026-10-15T12:00:00.000Z" }),
    event({ title: "国常会部署新一轮稳增长措施", publishedAt: "2026-10-15T09:00:00.000Z", source: "东方财富快讯" })
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].publishedAt, "2026-10-15T09:00:00.000Z");
});

test("items without a usable title key are never merged", () => {
  const out = dedupeEvents([event({ title: "公告" }), event({ title: "公告" })]);
  assert.equal(out.length, 2);
});
