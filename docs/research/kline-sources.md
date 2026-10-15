# A-share daily K-line endpoint probe — report

Environment: Windows, Node v26.9.0, plain `fetch`, `user-agent` header.
All numbers measured from this machine. Probe scripts in `D:\DeepSeek harness\.tmp-probe-history\`.

## Headline

1. **Tencent's `web.ifzq.gtimg.cn/appstock/app/fqkline/get` got WAF-blocked (HTTP 501) mid-session** and did not
   recover in 20+ minutes. Its **identical twin `proxy.finance.qq.com/ifzqgtimg/appstock/app/...` works and stayed
   10/10 under the same load.** Use the `proxy.finance.qq.com` host.
2. **No endpoint supports multi-symbol chained K-lines.** Batch size is 1 everywhere. Chaining Tencent returns HTTP 200
   with `{"code":0,"msg":"param error","data":[]}` (40 bytes).
3. **Tencent has zero BSE history** (1 bar, today only, for every `bj*` symbol and for `bj899050`). Sina covers BSE.
4. **Sina also enumerates the whole universe: 5575 symbols in one 1.4 s pass**, which removes the flaky Eastmoney
   dependency for the symbol list.

## A. Tencent K-line — RECOMMENDED for SH/SZ + indices

```
https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=<sym>,<scale>,<beg>,<end>,<n>,<fq>
referer: https://gu.qq.com/
```
- `<scale>` = `day` | `week` | `month`. `<fq>` = `qfq` | `hfq` | empty(raw). `<beg>/<end>` may be empty, or
  `2024-01-01,2024-12-31` (honoured, with `n` = 640 working).
- JSON path: `data.<sym>.qfqday` (or `.qfqweek`, `.qfqmonth`, `.day`, `.hfqday`, …). With no `fq` the key is the bare
  scale; **for indices the adjustment is ignored and the key is always `day`.**
- Row: `[date, open, close, high, low, volume]` — **note open, CLOSE, high, low**. Volume in **手**. The 7th element is
  sometimes a dividend object (`{"nd":"2024","fh_sh":"276.73",...}`) — tolerate `length > 6` and non-numeric extras.
- Units: prices CNY (adjusted when `qfq`), volume 手 (1 手 = 100 shares), date `YYYY-MM-DD`.

Bar limits (exact, verified):
| request | result |
|---|---|
| `n ≤ 800` + `qfq` | `n+1` bars (e.g. 250→251) |
| `n ≥ 801` + `qfq` | **silently degrades to 641 bars** |
| `n ≥ 2500` | `{"code":0,"msg":"param error","data":[]}` |
| `n=1000` + `week/month` + `qfq` | 640 bars |
| `n=1000` + **raw** week | **1000 bars**, back to 2007-04-13 |
| `n=1000` + **raw** month | 302 bars, back to 2001-08-31 |
| unknown symbol | `data.<sym>.day = []` (still HTTP 200, `msg:""`) — check the array length, not the status |

`qfq` correctness: exact vs Eastmoney `fqt=1` inside the window (sh600519 2024-01-02 open = 1580.661).
`hfq`: 2024-01-02 = 9548.13. Raw: 1715.000.
**`qfq` is broken on deep history** — `week` qfq starts 2014-04-25 with negative prices (`-161.537`), `month` qfq
starts 2001-08-31 at `-314.300`. Use **raw** for long lookbacks.

Also available on the same mirror:
- `.../newfqkline/get` — same shape but 10 fields:
  `[date, open, close, high, low, volume(手), {}, pct_change, amount(万元), flag]`.
- `.../kline/mkline?param=<sym>,m5,,320` — intraday `m1|m5|m15|m30|m60`, row
  `[YYYYMMDDHHMM, open, close, high, low, volume(手), {}, pct_change]`. **`n` is hard-capped at 320** (1000→320),
  so m5 covers only ~6.7 trading days. This endpoint is **dead on `web.ifzq.gtimg.cn`**
  (301 → `web3.ifzq.gtimg.cn` → `ENOTFOUND`) but works on `proxy.finance.qq.com`.

Reliability (proxy host, 10 runs, sh600519 250 bars qfq): **10/10, p50 70.5 ms, p95 302.7 ms, ~19.2 KB**.
Throughput, 200 real SH symbols, conc=20: **200/200 OK, 242 req/s, p50 65.3 ms, p95 174.7 ms, avg 16.7 KB**;
`n=800` variant: 200/200, 234 req/s, avg 49.6 KB.

## B. Sina K-line — RECOMMENDED for BSE, intraday, raw prices

```
https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_x=/CN_MarketDataService.getKLineData?symbol=<sym>&scale=<m>&ma=no&datalen=<n>
referer: https://finance.sina.com.cn/
```
- **The JSONP path is mandatory.** The plain `/CN_MarketDataService.getKLineData?...` returns
  `{"__ERROR":0,"__ERRORMSG":"Invalid service name"}`.
- Body = `/*<script>location.href='//sina.com';</script>*/ var _x=([...]);`. The prefix is a literal assignment, not a
  callback; unwrap with ``/\((\[.*\])\)\s*;?\s*$/s`` then `JSON.parse`. Over the limit you get `var _x=(null);` (63 B).
- Row: `{"day","open","high","low","close","volume"}` (+`"amount"` on intraday scales). **All values are strings**;
  intraday `day` is `"YYYY-MM-DD HH:MM:SS"`.
- **Prices are RAW / unadjusted** (2024-01-02 open 1715.000 = Eastmoney `fqt=0` = Tencent raw).
- **Volume is in SHARES — 100× Tencent/Eastmoney 手**, including index volume. Divide by 100.
- `scale` is in minutes: `5|15|30|60|120|240`, plus **`1200` = weekly** and **`7200` = monthly**.
- `datalen` **cap = 1023** (1024 accepted for weekly); 2000+ → `null`.

Coverage with `datalen=1023`: scale=5 → 21 trading days, 15 → 64 d, 30 → 128 d, 60 → 256 d, 120 → 512 d,
240 → 1023 d (2022-07-25), 1200 → back to 2006-10-20, 7200 → full history to 2001-08-31 (302 bars).

Reliability: **10/10, p50 46.5 ms, p95 139.5 ms**. 200 real symbols conc=20: **200/200 OK, 228 req/s,
p50 73.6 ms, p95 173.7 ms, avg 25.1 KB** (wire is ~50 % larger than Tencent for the same bars).

## C. Eastmoney K-line — richest, least reliable

```
https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=fa5fd1943c7b386f172d6893dbfba10b
 &fields1=f1,f2,f3,f4,f5,f6&fields2=f51,...,f61&secid=<mkt>.<code>&klt=<k>&fqt=<0|1|2>&beg=<date>&end=<date>&lmt=<n>
referer: https://quote.eastmoney.com/
```
- `secid` prefix `1.` = SH, `0.` = SZ **and BSE**.
- `data.klines[]` = `date,open,close,high,low,volume,amount,amplitude,pct_change,change,turnover_rate`.
  Volume 手, **plus `amount` in CNY**. `fqt` 0=raw, 1=qfq, 2=hfq.
- `end=&lmt=N` → exactly N bars. **`beg=0&end=20500101` overrides `lmt` and returns ALL history**
  (sh600519 6021 bars from 2001-08-27, 511 KB; sz000001 8496 bars from 1991-04-03).
- `klt` 101=day, 102=week, 103=month, 5/15/30/60=min. Same negative-price qfq artifact at 2001 (`-312.68`).
- **No batch:** `secids=A,B` → `rc:102 data:null`; `secid=A,B` → `rc:100 data:null`.
- **The host went hard down mid-session and never came back**: every request for the rest of the session returned
  `TypeError: fetch failed | cause=UND_ERR_SOCKET` (0.12–0.34 s, no HTTP status) — 30+ consecutive failures over
  30+ minutes. Earlier runs hit 351 req/s at conc=20, but conc=40 already produced `UND_ERR_SOCKET`.
  Its clist enumerator (10/10, p50 148 ms) died with it. **Treat as an optional tier 3 with retry/backoff, never a
  primary path.**

## Indices — what works where

| symbol | name | Tencent (proxy) | Sina | Eastmoney |
|---|---|---|---|---|
| `sh000001` | 上证指数 | ✅ `day` | ✅ scale 240 | ✅ `1.000001` |
| `sz399001` | 深证成指 | ✅ `day` | ✅ | ✅ `0.399001` |
| `sz399006` | 创业板指 | ✅ `day` | ✅ | ✅ `0.399006` |
| `sh000688` | 科创50 | ✅ `day` | ✅ | ✅ `1.000688` |
| `bj899050` | 北证50 | ❌ **1 bar only** | ✅ 1023 bars | ✅ `0.899050` |

Also verified working on Tencent: `sh000300` 沪深300. Index volume from Sina is 100× 手 (51016318900 vs 510163189).

## Intraday, for 5 / 10 / 15-day charts

| source | bars | span | verdict |
|---|---|---|---|
| Sina `scale=5&datalen=1023` | 1023 | **~21 trading days** | ✅ best multi-day intraday |
| Tencent `kline/mkline` m5 | 320 (hard cap) | ~6.7 trading days | ❌ cannot reach 10/15 days |
| Tencent `fqkline` with m5/m15/m30/m60 | — | — | ❌ `"bad params"` |

Exact bar counts: 5 trading days = 240 (scale 5), 10 = 480, 15 = 720, all ≤ 1023. Verified spans from today:
scale=5 240 bars → 2026-10-09 09:35; 480 → 2026-09-24; 720 → 2026-09-17.
Wider views on the same call: scale=15 (`2026-07-10`), 30 (`2026-04-07`), 60 (`2025-09-18`).
Tencent has one niche extra: `.../day/query?code=<sym>` returns today's 1-minute series
(`"0930 1286.00 357 45910200.00"` = HHMM price volume amount, 48 KB) and `.../minute/query` the abbreviated form.

## Universe enumeration — use Sina, not Eastmoney

```
https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData
  ?page=<p>&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page
referer: https://finance.sina.com.cn/
```
- **Plain JSON, no JSONP unwrap.** Rows: `symbol,code,name,trade,pricechange,changepercent,buy,sell,settlement,
  open,high,low,volume,amount,ticktime,per,pb,mktcap,nmc,turnoverratio`.
- `num` is **clamped to 100** (same as Eastmoney's `pz`), so 56 pages.
- **Full pass: 5575 symbols in 1.4 s at conc=8, 0 errors** — `{sh: 2319, sz: 2906, bj: 350}`, all unique.
  `hs_a` includes BSE. `Market_Center.getHQNodeStockCount?node=hs_a` → `"5575"` as a cross-check.
- Eastmoney's equivalent (`clist/get`, `pz` clamped to 100, `data.total=5562`) is now unusable while that host is down.

## Sizing

Per stock, 250 daily bars: Tencent wire 19.2 KB → compact JSON `[[o,c,h,l,v],…]` **10 422 B (41.5 B/bar)**;
with dates 13 685 B; float32 `[o,c,h,l,v,ts]` binary 6024 B.
Whole universe (5600 × 250 bars): **compact JSON ≈ 55.7 MB**, float32 ≈ 32.2 MB. Sina wire for the same is ~25 KB/stock.

## Recommendations

**(a) Daily full-universe history sync (~5600 stocks)**
1. Symbol list: `listUniverse()` — one 1.4 s pass, cache it, refresh daily. No Eastmoney dependency.
2. Bars: **Tencent via `proxy.finance.qq.com`**, one request per symbol `day,,,800,qfq` gives 801 bars (~3.2 years)
   in the same single request — **5600 symbols ≈ 24 s at conc=20**, 0 failures measured on 200-symbol A/B runs.
   Store qfq for charting; if you need deep/adjusted-stable history, store raw and adjust client-side or use Eastmoney
   `beg=0` as a nightly tier-3 backfill.
3. **BSE (350 symbols) must go to Sina `scale=240&datalen=1023`** (~raw, /100 for 手) — Tencent returns 1 bar.
4. Keep conc ≤ 20. Do not exceed it on Eastmoney at all. Treat any `msg:"param error"` as an error even on HTTP 200.

**(b) On-demand single-stock chart**
- SH/SZ + indices: **one Tencent call** — `day|week|month,,,N,qfq`, N ≤ 800, server-side qfq, p50 65 ms.
- BSE: **one Sina call** — `scale=240|1200|7200&datalen=1023`, raw, /100 the volume.
- Intraday 5/10/15-day charts: **Sina `scale=5|15|30|60&datalen=≤1023`** — the only source that spans >7 days.
- Route by symbol prefix (`bj` → Sina) and you never need more than one HTTP request per chart.

## What failed, with exact errors

| attempt | exact failure |
|---|---|
| `web.ifzq.gtimg.cn/appstock/app/fqkline/get` | `status=501` + Tencent WAF body (`window.location.href="https://waf.tencent.com/501page.html?u=..."`), 323–326 B, UA/referer/http-vs-https-independent, still 501 after 20 min |
| `web.ifzq.gtimg.cn/.../kline/mkline` | `HTTP 301` → `web3.ifzq.gtimg.cn` → `TypeError: fetch failed \| cause=ENOTFOUND getaddrinfo ENOTFOUND web3.ifzq.gtimg.cn -3008` |
| `web2.ifzq.gtimg.cn` | `ENOTFOUND` |
| Tencent multi-symbol `param=A,…;B,…` (also `\|`, `%3B`, `%0A`, `&param=` twice, `newfqkline`) | HTTP 200 `{"code":0,"msg":"param error","data":[]}` (40 B); `&param=A&param=B` returns only the last symbol |
| Tencent BSE (`bj920047`, `bj920992`, `bj899050`, `bj430047`) | `day` = 1 bar (today) for any requested range; `bj430047` = `day:[]`, the old pre-Oct-2025 BSE code is dead |
| `push2his.eastmoney.com` (all paths, incl. clist) | `TypeError: fetch failed \| cause=UND_ERR_SOCKET`, no HTTP status, from mid-session onward |
| `push2.eastmoney.com`, `push2delay`, `82.push2` | `UND_ERR_SOCKET` (known before probing) |
| Sina plain (non-JSONP) `getKLineData` | `{"__ERROR":0,"__ERRORMSG":"Invalid service name"}` |
| Sina `datalen` > 1023 | `var _x=(null);` (63 B) |
| Sina node `bj_a` | `[]` (2 B) — use `hs_a`, which does contain BSE |
| `qt.gtimg.cn` > 500 symbols | `TypeError: fetch failed \| cause=ERR_HTTP2_SESSION_ERROR` |
| `hq.sinajs.cn` 1000 symbols | `HTTP 431` |

## Copy-paste: the top recommendation

Full working module at `.tmp-probe-history/recommended.mjs` (smoke-tested end to end).

```js
// A-share daily K-line reader. Node >= 20, no deps. Tencent(proxy) -> Sina fallback.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const TEN = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get';
const SIN = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_x=/CN_MarketDataService.getKLineData';

async function get(url, referer) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** rows = [open, close, high, low, volume(手)] — note open, CLOSE, high, low. */
export async function dailyBars(sym, bars = 250) {
  if (!sym.startsWith('bj')) {                       // Tencent has no BSE history
    try {
      const txt = await get(`${TEN}?param=${sym},day,,,${Math.min(bars, 800)},qfq`, 'https://gu.qq.com/');
      const d = JSON.parse(txt).data?.[sym];
      const key = d && Object.keys(d).find((k) => Array.isArray(d[k]) && d[k].length);
      if (key) return { adjust: 'qfq', dates: d[key].map((r) => r[0]),
                        rows: d[key].map((r) => [+r[1], +r[2], +r[3], +r[4], +r[5]]) };
    } catch { /* fall back */ }
  }
  const txt = await get(`${SIN}?symbol=${sym}&scale=240&ma=no&datalen=${Math.min(bars, 1023)}`,
                        'https://finance.sina.com.cn/');
  const hit = txt.match(/\((\[.*\])\)\s*;?\s*$/s);    // JSONP is mandatory here
  if (!hit) throw new Error('sina: null payload (datalen > 1023 or unknown symbol)');
  const a = JSON.parse(hit[1]);
  return { adjust: 'raw', dates: a.map((r) => r.day),
           rows: a.map((r) => [+r.open, +r.close, +r.high, +r.low, +r.volume / 100]) }; // shares -> 手
}

// Full universe, 5575 symbols in ~1.4 s: plain JSON, num is clamped to 100 -> 56 pages.
export async function listUniverse(concurrency = 8) {
  const url = (p) => 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php'
    + `/Market_Center.getHQNodeData?page=${p}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`;
  const out = [], queue = Array.from({ length: 56 }, (_, i) => i + 1);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) out.push(...JSON.parse(await get(url(queue.shift()), 'https://finance.sina.com.cn/')));
  }));
  return out; // [{symbol:'sh600519', code, name, per, pb, mktcap, ...}]
}

// ~24 s for 5600 symbols at conc=20. Keep conc <= 20.
export async function syncAllDaily(symbols, bars = 800, concurrency = 20) {
  const results = new Map(), errors = [], queue = [...symbols];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try { results.set(s, await dailyBars(s, bars)); } catch (e) { errors.push([s, e.message]); }
    }
  }));
  return { results, errors };
}
```
