/**
 * Statutory A-share closures that fall on a weekday, for dates the empirical
 * calendar cannot see yet.
 *
 * `data/flow.json` records the last 250 trading sessions, so `lib/trading-days.json`
 * is exact for the past — but it says nothing about a holiday that has not
 * started. That gap matters: the 明日参考 board is rendered on the evening before
 * a break, exactly when "next trading day" is a guess.
 *
 * Solar-fixed holidays (元旦 / 清明 / 劳动节 / 国庆) are certain. The lunar ones
 * (春节 / 端午 / 中秋) follow the statutory calendar and should be re-checked
 * against the State Council notice published each November; the lunar dates here
 * follow the usual "about eleven days earlier than last year" drift.
 *
 * `scripts/build-trading-calendar.js` cross-checks every entry that later falls
 * inside the observed window and warns when the two disagree, so a stale list
 * shows up in CI logs instead of silently mislabelling a date.
 */
/**
 * Last date whose weekday/weekend split is fully backed by a published notice.
 *
 * The State Council publishes the next year's holiday arrangement each November,
 * and `data/flow.json` already confirms every closure up to its last session.
 * Between that session and the end of the current year the only statutory break
 * is 元旦 — there is nothing left to guess — so "下一交易日" can be quoted as an
 * exact date instead of being hedged as a weekday estimate.
 *
 * Bump this every December when the new notice lands.
 */
export const VERIFIED_THROUGH = "2026-12-31";

export const FORWARD_CLOSURES = [
  // 元旦
  "2027-01-01",
  // 春节 (正月初一 2027-02-06, 周六)
  "2027-02-05",
  "2027-02-08",
  "2027-02-09",
  "2027-02-10",
  "2027-02-11",
  "2027-02-12",
  // 清明 (2027-04-05, 周一)
  "2027-04-05",
  // 劳动节 (05-01 周六, 05-02 周日)
  "2027-05-03",
  "2027-05-04",
  "2027-05-05",
  // 端午 (2027-06-09, 周三)
  "2027-06-09",
  // 中秋 (2027-09-15, 周三)
  "2027-09-15",
  // 国庆 (10-01 周五, 10-02/03 周末)
  "2027-10-01",
  "2027-10-04",
  "2027-10-05",
  "2027-10-06",
  "2027-10-07"
];
