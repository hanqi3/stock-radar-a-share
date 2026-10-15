# Probe report — A-share data endpoints (announcements / news / sectors / pinyin)

All work done in `D:\DeepSeek harness\.tmp-probe-news\`. Nothing outside that dir was modified.
Runtime: Node v26.9.0, npm 11.19.1, Windows.
Headers used everywhere unless noted: `User-Agent` = Chrome/124 UA string.
Reliability = 5 sequential requests per endpoint unless stated.

## TL;DR source selection

| Need | Use | Status |
|---|---|---|
| Announcements, market-wide + per-stock | **cninfo POST** `hisAnnouncement/query` | 5/5, 140–265 ms |
| Announcements (cleaner JSON, types) | **EM** `np-anotice-stock…/api/security/ann` | 5/5, 78–357 ms |
| News (market/policy) | **Sina roll** lid 2516/2517 + **Sina 7×24** + **EM kuaixun 102** | 5/5 each, no auth |
| Stock → industry/concepts | **EM** `datacenter-web … RPT_F10_CORETHEME_BOARDTYPE` | 5/5, batchable |
| Industry/concept → members | **EM** same report, `filter=(NEW_BOARD_CODE="BKxxxx")` | 5/5 |
| Sector daily perf + 5/20/60d + YTD | **Tencent** `rank/pt/getRank` (31 hy in one call) | 5/5 |
| Sector daily perf from Sina | `newSinaHy.php` / `newFLJK.php?param=class` | 5/5, GBK |
| Node-id sector tree (industry list) | **Sina** `Market_Center.getHQNodes` | 5/5, 1970 ids |
| Pinyin | **pinyin-pro 3.29.5** | npm reachable |
| Anything on `push2*.eastmoney.com` | — | **DEAD, do not use** |

---

## GOAL A — announcements

### A1. cninfo (巨潮资讯) — market-wide, primary source

```
POST http://www.cninfo.com.cn/new/hisAnnouncement/query
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
User-Agent: <chrome>
Referer: http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice
X-Requested-With: XMLHttpRequest
Accept: application/json, text/javascript, */*; q=0.01
```
Body (URLSearchParams) — defaults that work:
```
pageNum=1&pageSize=30&column=szse&tabName=fulltext&plate=&stock=&searchkey=&secid=
&category=&trade=&seDate=&sortName=time&sortType=desc&isHLtitle=true
```
- `seDate` = `YYYY-MM-DD~YYYY-MM-DD` (empty = all time).
- `sortName=time&sortType=desc` gives newest-first without a date filter (market-wide all-time total = 348,679).
- **`pageSize` is capped at 30** (100/200 silently return 30 rows).
- `column=szse` and `column=sse` return the *same* market-wide set; `third`/`neeq` return 0. Always send `szse` — it is effectively a no-op.
- **`stock=` requires `code,orgId`**: `stock=600519,gssh0600519` → total=155 ✓; `stock=600519` → **total=0**; `stock=600519,` → **total=1,211,190** (silently returns the whole market). Get `orgId` from `szse_stock.json`.
- **`searchkey` is FULL-TEXT body search**, not title search (returned `<em>`-highlighted titles and unrelated stocks; `searchkey=年报` → total=58,091).
- `category=category_ndbg_szsh` (年报) works → total=22,547.
- `announcementType` / `columnId` are `||`-joined code strings (`01010503||010112||010301`); use the readable **`announcementTypeName`**.
- `categoryList` and `classifiedAnnouncements` came back **`null`** in sampled responses — do not depend on cninfo's taxonomy.

Response top keys: `classifiedAnnouncements, totalSecurities, totalAnnouncement, totalRecordNum, announcements, categoryList, hasMore, totalpages`.

Item → needed fields:
- title → `announcementTitle`
- date → `announcementTime` (**epoch ms**, e.g. `1792080000000`)
- URL → `'http://static.cninfo.com.cn/' + adjunctUrl` (e.g. `finalpage/2026-08-15/1225475868.PDF`)
- stock code → `secCode` (+ `secName`, `tileSecName`, `orgName`, `secNameList`)
- type → `announcementTypeName`
- also `shortTitle, orgId, announcementId, adjunctSize, adjunctType ("PDF"), columnId, pageColumn, storageTime, id, important, batchNum, associateAnnouncement, announcementContent`

Verified: PDF URL fetch → **200, 832,321 B, `content-type: application/pdf`, magic `%PDF-`**.

Reliability 5/5 each: market-wide all-time 141–156 ms (22,188 B) · market-wide today-only `seDate=<today>~<today>` 118–151 ms · per-stock 600519 100–129 ms (6,767 B) · `category=年报` 105–133 ms (6,778 B).

```js
const CN = {
  'User-Agent': UA,
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Referer': 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
};
const today = new Date().toISOString().slice(0, 10);

export async function cninfoAnnouncements({ pageNum = 1, pageSize = 30, stock = '', orgId = '',
  searchkey = '', category = '', seDate = '', sortDesc = true } = {}) {
  const body = new URLSearchParams({
    pageNum: String(pageNum), pageSize: String(pageSize), column: 'szse', tabName: 'fulltext',
    plate: '', stock: stock ? `${stock},${orgId}` : '', searchkey, secid: '', category,
    trade: '', seDate, sortName: sortDesc ? 'time' : '', sortType: sortDesc ? 'desc' : '',
    isHLtitle: 'true',
  }).toString();
  const r = await fetch('http://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers: CN, body });
  const j = await r.json();
  const rows = (j.announcements || []).map((a) => ({
    title: a.announcementTitle.replace(/<[^>]+>/g, ''),
    date: new Date(a.announcementTime).toISOString(),
    url: 'http://static.cninfo.com.cn/' + a.adjunctUrl,
    code: a.secCode, name: a.secName, type: a.announcementTypeName, orgId: a.orgId,
    announcementId: a.announcementId, type3: a.announcementType,
  }));
  return { total: j.totalAnnouncement, pages: j.totalpages, rows };
}

// usage
await cninfoAnnouncements({ seDate: `${today}~${today}`, pageSize: 30 });          // today's market feed
await cninfoAnnouncements({ stock: '600519', orgId: 'gssh0600519', pageSize: 30 }); // per stock
```

Supporting file: `http://www.cninfo.com.cn/new/data/szse_stock.json` → 200, 592,677 B,
`{"stockList":[{code,pinyin,category,orgId,zwjc}]}` e.g. `{"code":"000001","pinyin":"payh","category":"A股","orgId":"gssz0000001","zwjc":"平安银行"}`.
Despite the name it covers **SH + SZ + BJ**: 6181 A-shares (`A股|B股|CDR`). `sse_stock.json` → **404**.
`topSearch/query?keyWord=茅台` → non-2xx (dead).

### A2. Eastmoney notices — better JSON, real announcement types

```
GET https://np-anotice-stock.eastmoney.com/api/security/ann
    ?sr=-1&page_size=50&page_index=1&ann_type=A&client_source=web&f_node=0&s_node=0
Referer: https://data.eastmoney.com/notices/
```
- Market-wide: omit `stock_list`. Per-stock/batch: `&stock_list=600519` (total 1074) or `&stock_list=600519,000001` (total 3230 — multi-code accepted).
- Date filter: `&begin_time=2026-01-01&end_time=2026-12-31` works (1074 → 62).
- `ann_type=A`; `ann_type=SHA,SZA` also works.
- **`page_index` is ignored/broken** — page 2 returned the *same* first row as page 1. Page by date windows instead.
- Market-wide `total_hits` **caps at exactly 50000**.

Shape `{data:{list,page_index,page_size,total_hits},error,success}`.
Item → title `title` (also `title_ch`,`title_en`), date `notice_date` `"2026-08-15 00:00:00"` (+ `display_time` `"2026-08-14 20:41:29:380"`, `sort_date`), URL `https://data.eastmoney.com/notices/detail/{stock_code}/{art_code}.html`, stock code `codes[].stock_code` (+ `codes[].short_name`, `market_code`, `inner_code`, `ann_type`), type `columns[].column_name` (e.g. "其他", "诉讼仲裁"; `columns[].column_code`), id `art_code` (`AN202608141827994407`), plus `language`, `listing_state`, `source_type`, `eiTime`.

PDF/live content: `GET https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=AN…&client_source=web&page_index=1` → `{data:{attach_list:[{attach_url:"https://pdf.dfcfw.com/pdf/H2_AN…_1.pdf?…",attach_size,attach_type,seq}],attach_list_ch:[…]}}`. HTML detail page also 200.

Reliability 5/5: market-wide 78–357 ms (34,432 B) · per-stock 80–101 ms.

### A3. Sina announcements — NONE WORKING
- roll lids 2519–2526 → `total=undefined` (invalid).
- `…/Announcement.getAnnouncementList?…` → `{"__ERROR":3,"__ERRORMSG":"Service not valid"}`.
- `…/corp/go.php/vCB_AllBulletin/stockid/600519.phtml` → 200 HTML but **GBK** (`charset=gbk`), needs a GBK decode; no clean JSON feed exists.

---

## GOAL B — news

### B1. Sina 7×24 live (`https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=30&zhibo_id=152&tag_id=0`) — 5/5, 60–600 ms, 51–60 KB, fresh
Shape: **`{result:{status,timestamp,data:{feed:{list:[…]}}}}`** — the path is `j.result.data.feed.list` (a common mistake yields `TypeError: Cannot read properties of undefined (reading 'feed')`).
`feed` also has `list,html,page_info,max_id,min_id,survey_id`.
Item: `id`, **`rich_text`** (title is the leading 【…】 inside it → `/^【(.+?)】/`), **`create_time`** `"2026-10-15 18:18:41"`, `update_time`, `commentid`, **`docurl`**, `like_nums`, `top_value`, `type`, `tag` = `[{id,name}]`, `ext` = **JSON string** with linked stocks:
`{"stocks":[{"market":"cn","symbol":"sz300502","key":"新易盛"},{"market":"worldIndex","symbol":"znb_nky","key":"日股"}],"docurl":"…","docid":"niviekn1436401"}` → `JSON.parse(item.ext).stocks`.
Caps/params: `page_size=30` or `100` works; **`page_size=500` returns only 10**. `tag_id=0` company/all, `1` policy (财政部…), `2` data (乘联分会…). `zhibo_id=152` required (`151` = unrelated room, `1` = empty text).

### B2. Sina roll news (`https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid={lid}&num=50&page=1`) — 5/5, 75–680 ms, ~105–110 KB
Shape `{result:{status,timestamp,total,data:[…]}}`; `result.total` is a global counter (~100k), not a page count.
Item: **`title`**, `intro` (≈summary, can be empty), `summary`, `wapsummary`, **`ctime` = epoch SECONDS as a string** (`"1792059645"`), `mtime`, `intime`, `url`, `wapurl`, **`docid`**, `media_name`, `author`, `keywords`, `commentid`, `img`, `images`, `lids`, `oid`, `channelid`, `categoryid`, `hqChart` (JSON string, usually empty).
Verified lids: `2516` 股市 (total≈100,287) · `2517` 要闻/产经 (≈100,381) · `2515` 财经 (100,038) · `2510` 全部财经 (51,633) · `2511` (38,344) · `2514` (35,789).

```js
const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=50&page=1`;
const j = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } })).json();
const rows = j.result.data.map((d) => ({
  title: d.title, summary: d.intro || d.summary,
  time: new Date(Number(d.ctime) * 1000).toISOString(), url: d.url, docid: d.docid,
}));
```

### B3. Eastmoney kuaixun (`https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`) — 5/5, 150–870 ms, paging works
Body is **JS, not JSON**: `JSON.parse(text.replace(/^var\s+ajaxResult\s*=\s*/, ''))`.
Shape `{rc:1,LivesList:[…],PageCount,AllCount,AtPage,MaxID,MinID}`.
Item: **`title`**, **`digest`** (summary), **`showtime`** `"2026-10-15 18:17:20"`, **`url_w`** (article URL; also `url_m`, `url_unique`, `url_pdf`), `id`, `newsid`, `sort`, `ordertime`, `commentnum`, `column` (`"100,101,102,103,104,105,110"`), `type`, `topic`, `image`, `titlestyle`, `simtitle`, `simdigest`, `newstype`.
Paging verified 5/5 per page: p1 newest 18:17:20 · p2 16:59:48 · p3 16:02:32. Working variants: `_50_2_.html`, `_50_1_2.html`, `_100_1_.html` (n=100), `_50_1_<MinID>.html`.

### B4. Eastmoney np-weblist / np-listapi — work only with `req_trace` (unnecessary; B3 is better)
`https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=<uuid>` → `{code:"1",data:{total:5000,fastNewsList:[{title,summary,showTime,code,stockList,realSort,image,…}]}}`.
`https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=345&order=1&page_index=1&page_size=20&req_trace=<uuid>` → `{code:"1",data:{page_index,list:[{title,summary,showTime,url,code,…}]}}` (column 345 and 350 both work).
Exact errors without the params: `{"code":0,"message":"Required String parameter 'req_trace' is not present","data":null}`; same for `'sortEnd'`. Response `sortEnd` is `undefined` → no cursor paging.

### B5. 财联社 CLS (`https://www.cls.cn/v1/roll/get_roll_list`) — 5/5, 61–278 ms, 54 KB, **needs a signature**
Unsigned request → `{"errno":"10012","msg":"签名错误"}`.
Working recipe: `sign = md5(sha1(paramsSortedByKeyJoinedWithAmpersand))`.
Params `{app:'CailianpressWeb', os:'web', sv:'7.7.5', category:'', lastTime:'', last_time:'', rn:'20'}` → qs `app=CailianpressWeb&category=&lastTime=&last_time=&os=web&rn=20&sv=7.7.5` → sign `200815020980f404865a4145c2d1e4d1` → GET `https://www.cls.cn/v1/roll/get_roll_list?<qs>&sign=<sign>`.
Shape `{errno:0,msg:"",data:{roll_data:[…]}}`.
Item: **`title` (already clean — no 【】 parsing)**, `content` (【title】+body), `brief`, **`ctime` epoch seconds**, `modified_time`, `id`, `level`, `reading_num`, `comment_num`, `shareurl`, `tags`, `stock_list`, `plate_list`, `subject`, `author`, `is_top`, `imgs`/`images`.
Paging unverified — `last_time=<oldest ctime>` returned the same newest batch; fetch and dedupe by `id`.
Dead: `/nodeapi/telegraphList`, `/nodeapi/updateTelegraphList`, `/api/sw` (`FAIL undefined`); `/v3/depth/home/assembled/1000` (10012).

### B6. Tencent news — 5/5 but NOT A-share/policy news
`https://r.inews.qq.com/gw/event/pc_hot_ranking_list?ids_hash=&offset=0&page_size=20&appver=15.5_qqnews_7.1.60&rank_id=` → `{ret:0,idlist:[{ids_hash,has_more,newslist:[{id,title,…}]}]}` ("腾讯新闻热点，每10分钟更新").
404s: `r.inews.qq.com/web_feed/getHomeVideoList`, `i.news.qq.com/web_backend/getChannelFeedsList?channel=finance`, `i.news.qq.com/web_backend/getSubNewsList?channel=finance`.

**Verdict: 3 recommended feeds = Sina roll 2516/2517, Sina 7×24, EM kuaixun 102.** CLS optional (sign). Tencent reject.

---

## GOAL C — industry + concept sectors, and membership

### C1. Sina node tree (`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodes`, `Referer: https://finance.sina.com.cn/`) — 5/5, 91,351 B, 50–156 ms
Root `["行情中心",[["A股",[["新浪行业",[["玻璃行业","","new_blhy"],…]],…]],…]]` — nodes are `[name, "", id]` triples. Collect every id-shaped string → **1970 ids**. Full scheme:

| Family | Count | Meaning | Samples |
|---|---|---|---|
| `new_*` | 49 | 新浪行业 | `new_blhy` 玻璃行业, `new_cmyl` 传媒娱乐, `new_ljhy` 酿酒行业, `new_cbzz` 船舶制造 |
| `sw_*` | 31 | 申万行业 (no level) — **cleanest industry list** | `sw_mt` 煤炭, `sw_sysh` 石油石化, `sw_mrhl`, `sw_hb`, `sw_dlsb`, `sw_shfw` |
| `sw1_*` | 32 | 申万一级 | `sw1_340000` 食品饮料, `sw1_740000`, `sw1_760000`, `sw1_750000` |
| `sw2_*` | 132 | 申万二级 | `sw2_340500` 白酒Ⅱ, `sw2_270100` 半导体 |
| `sw3_*` | 337 | 申万三级 | `sw3_340501` 白酒Ⅲ |
| `gn_*` | 213 | 概念板块 | `gn_hwqc` 华为汽车, `gn_BCdc`, `gn_hwhs`, `gn_cxy` |
| `chgn_*` | 705 | 热门概念 | `chgn_701303` DeepSeek概念, `chgn_730629` 湖北国资 |
| `diyu_*` | 31 | 地域 | `diyu_650000` 新疆 |
| `hangye_*` | 109 | 证监会行业 | `hangye_ZA01` 农业 (explains why legacy `hangye_ZL01` worked) |

Plus 分类 (`hs_a hs_b sh_a sh_b sz_a sz_b hs_bjs sh_s shfxjs delist_st cyb kcb hs300 hsgs_*`), ~50 `zhishu_*` indices, ~30 `stock_*` 排行, and non-A-share families (基金/港股/债券/美股/外汇/期货/黄金 — ignore).
Every family spot-verified queryable: `sw_mt`=33 (郑州煤电) · `sw1_340000`=126 · `sw2_340500`=19 · `sw3_340501`=19 · `new_ljhy`=33 · `gn_hwqc`=97 · `chgn_701303`=628 · `diyu_650000`=62 · `hangye_ZA01`=15.
Container/group ids are **not** queryable (`sw2`, `hangye`, `diyu`, `ch_gn`, `gn_gnbk`, bare concept names → 0 rows / `[]`).

### C2. Sina members — "all stocks in industry X" — 5/5, 35–56 ms
`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=100&sort=symbol&asc=1&node={id}&symbol=&_s_r_a=page` → **bare JSON array**.
Item: `symbol` (`sh600519` / `bj920092`), `code`, `name`, `trade`, `pricechange`, `changepercent`, `buy`, `sell`, `settlement`, `open`, `high`, `low`, `volume`, `amount`, `ticktime`, `per` (PE), `pb`, `mktcap` (万元), `nmc` (万元), `turnoverratio`.
Companion `Market_Center.getHQNodeStockCount?node={id}` → bare number as text (`"33"`), `[]` if invalid.
**`num` is hard-capped at 100** (200/500/1000 all return exactly 100) → loop `page`.
```js
export async function sinaMembers(nodeId) {
  const H = { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' };
  const cnt = await (await fetch(`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=${nodeId}`, { headers: H })).text();
  const total = Number(cnt.replace(/\D/g, '')) || 0;
  const out = [];
  for (let page = 1; out.length < total && page <= Math.ceil(total / 100); page++) {
    const u = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=${nodeId}&symbol=&_s_r_a=page`;
    const rows = JSON.parse(await (await fetch(u, { headers: H })).text());
    if (!rows.length) break;
    out.push(...rows);
  }
  return out; // .map(r => ({ code: r.code, name: r.name, pct: +r.changepercent }))
}
```
This is the **only reliable "all stocks in industry X" route left**, because `push2his fs=b:BK…` is dead.

### C3. Sina sector daily performance aggregate — 5/5, **GBK**
`new TextDecoder('gbk').decode(buf)`, strip `var S_Finance_bankuai_<x> = `, then `JSON.parse` the object map.

| URL | Content | Bytes |
|---|---|---|
| `https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php` | 49 新浪行业 | 6,807 |
| `https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class` | 175 live concepts (`gn_*`) | 23,784 |
| `https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=area` | 31 regions (`diyu_*`) | 4,388 |
| `https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=industry` | 84 证监会行业 | 11,937 |

`param=sw|sw1|sw2|sw3|all` all return the **same 84 `hangye_*` rows** — there is no 申万 aggregate feed; use Tencent for 申万 performance.
CSV field order (verified against members): `id, name, memberCount, avgPrice, avgChangeAmount, avgChangePct, totalVolume, totalAmount, leaderSymbol, leaderChangePct, leaderPrice, leaderChangeAmount, leaderName`.
- idx2 = member count — matches `getHQNodeStockCount` exactly (酿酒 33, 玻璃 19).
- idx6/7 = totals matching member sums **exactly** (酿酒 447,095,221 / 17,926,278,274).
- idx8–12 = leader — matched exactly (皇台酒业 10.041 / 13.370 / 1.220).
- **Limitation: idx5 `avgChangePct` is not the equal-weighted member mean** — 酿酒 feed `+1.2885%` vs member mean `-0.4761%`; 玻璃 `-3.9892%` vs `-3.3384%`; `avgPrice` 65.49 vs computed 63.52. Treat it as Sina's own 板块涨跌幅.

### C4. Eastmoney F10 board membership (`datacenter-web`) — **the membership workhorse, 5/5 both directions, 66–238 ms**
```
GET https://datacenter-web.eastmoney.com/api/data/v1/get
    ?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=ALL
    &filter=(SECUCODE="600519.SH")     # or (NEW_BOARD_CODE="BK0896")
    &pageNumber=1&pageSize=1000&source=HSF10&client=PC
Referer: https://data.eastmoney.com/notices/
```
- **stock → all boards:** `(SECUCODE="600519.SH")` 28 rows · `000001.SZ` 24 · `300750.SZ` 37. `(SECURITY_CODE="600519")` also works.
- **board → all members:** `(NEW_BOARD_CODE="BK0896")` 白酒 **41 rows** · `BK0475` 银行Ⅱ **42** · `BK0999` 茅指数 42 · `BK0596` 融资融券 1000 rows on p1 with `pages:4` → loop `pageNumber`, `pageSize` caps at 1000.
- **Batch:** `filter=(SECUCODE in ("600519.SH","000001.SZ"))` **works** (52 rows). `(SECUCODE="A")(SECUCODE="B")` and `(SECUCODE="A,B")` fail with `返回数据为空` → always use `in (...)`.
- Measured batch: in(20)→519 rows/1 page; in(50)→1000/2 pages (46/50); in(100)→1000/3 (93/100); in(200)→1000/4 (180/200); in(300)→1000/6 (258/300).

Row fields: `SECUCODE`, `SECURITY_CODE`, `SECURITY_NAME_ABBR`, `BOARD_CODE`("896"), `BOARD_NAME`("白酒"), `NEW_BOARD_CODE`("BK0896"), `DERIVE_BOARD_CODE`, `SELECTED_BOARD_REASON` (prose, often null), **`IS_PRECISE`** ("1" = 主营/核心, "0" = 泛概念), `BOARD_RANK`, `BOARD_YIELD` (always null), `BOARD_TYPE`, `BOARD_LEVEL`.
Boards mix industry + concept + index + region + style (茅指数, 标准普尔, 富时罗素, MSCI中国, 沪股通, 融资融券, 贵州板块, 大盘股…).
**Classification limitation (6000 rows sampled):** `BOARD_TYPE` is `null` for 5791 and `"行业"` for only 209; `BOARD_LEVEL` `null`/`"2"` likewise ⇒ Eastmoney does **not** label industry vs concept. Classify by joining `NEW_BOARD_CODE`/`BOARD_NAME` to an industry list from the Sina tree (or Tencent hy / the stale `RPT_INDUSTRY_LIST`).
**Zero-board caveat:** 23/300 sampled stocks returned no board rows at all (300023 宝德退, 300028 金亚退, 300104 乐视退, 300108 *ST吉药, 300156 神雾退, …) — delisted/suspended. Full-market harvest ≈ **0.8 min, ~144 requests** for 6181 stocks, ~94,509 rows.
Related `reportName` values: `RPT_F10_BASIC_ORGINFO` works (company profile). `RPT_INDUSTRY_LIST` works but is **stale** (`LATEST_DATE:"2024-12-01"`). Dead with `{"success":false,"message":"报表配置不存在,<name>","code":9501}`: `RPT_BOARD_LIST`, `RPT_BOARD_TRADE`, `RPT_BK_QUOTE`, `RPT_BOARD_QUOTE`, `RPT_VALUEBOARD`, `RPT_INDUSTRY_STOCK`, `RPT_BOARD_STOCK`, `RPT_INDUSTRY_QUOTE`, `RPT_CUSTOM_BOARD_LIST`.

### C5. Tencent sector rank — per-sector daily + 5/20/60d + YTD, 5/5, 58–155 ms
`https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type={hy|gn|dy}&sort_type=price&direct=down&offset=0&count=100` with `Referer: https://gu.qq.com/`.
- `board_type=hy` → **exactly 31 rows = all 申万一级 industries in ONE call** (count 50/100/200 all → 31).
- `board_type=gn` → count max 200; offset 0/200/400/600 → **800 concept boards, 0 duplicates**.
- `board_type=dy` → 31 regions in one call.
- `count≥300` → `{"code":1619377101,"msg":"error_type=2 suggest=2 msg=参数错误:count too large"}`.

Row: `code`, `name`, `stock_type` (`BK-HY-1`/`BK-GN-FG`/`BK-DY`), `zdf`, `zd`, `zdf_d5`, `zdf_d20`, `zdf_d60`, `zdf_w52`, `zdf_y`, `zxj`, `zsz`, `ltsz`, `hsl`, `lb`, `zgb` ("1/33" = up/total), `speed`, `turnover`, `volume`, `zljlr`, `zljlr_d5`, `zljlr_d20`, `zllr`, `zllc`, `lzg` = `{code,name,zdf,zd,zxj}`.
Sample 2026-10-15: 食品饮料 `pt01801120` +0.72 / ytd −14.61 / zljlr 32086.48 / 皇台酒业 sz000995 +10.04 · 电子 `pt01801080` −2.93 / −9.58(5d) / −16.64(20d) / −28.87(60d) / +8.62(ytd) / zljlr −1,336,337.72 · 通信 −4.64/−11.70/−21.06/−30.86/+4.99 · 银行 −0.16/+0.50/+2.58/+9.03/+2.04.
`rank/hs/getBoardRankList` is dead/empty. **Tencent `pt…` codes do not encode BK codes** (0/31 hy names matched the sampled EM name set) ⇒ a curated `pt ↔ BK ↔ Sina-node` map is required.
No Tencent single-stock plate endpoint: `stock/plate/getPlateStockList`, `StockInfo/getStockInfo`, `stock/f10/getStockPlate` all dead (`Can't load controller:StockInfoController` / `FAIL undefined`). `https://qt.gtimg.cn/q=sh600519` works but is **GBK and quote-only** (no board info).

### C6. `push2*.eastmoney.com` — DEAD, do not depend on it
0/12 successes across board list (`fs=m:90+t:2`), board members (`fs=b:BK0896`), board kline (`secid=90.BK0896`) and stock kline (`secid=1.600519`) — every one `TypeError: fetch failed | cause=UND_ERR_SOCKET`. Also down: `push2.eastmoney.com`, `push2delay.eastmoney.com`, `push2ex.eastmoney.com`. DNS resolves fine (`push2his` → 61.129.129.199), so it is a connect-level block; no header combination helps. `push2his` *did* answer in an early round and then went permanently down mid-session ⇒ treat any `fs=m:90…` / `fs=b:BK…` design as unusable.
When it was up it returned: board list total 496 行业 / 508 概念 / 31 地域, rows `f12`=BK code, `f14`=name, `f2`=index, `f3`=pct, `f62`=main net inflow, `f104`/`f105`=up/down, `f128`/`f140`=leader name/code; members via `fs=b:BK0896`; klines as CSV strings.

### C7. Coverage gap (sourcing decision)
cninfo `szse_stock.json` = **6181 A-shares**; Sina `hs_a` = **5575 unique** (all 56 pages) and fully a subset (`in sina NOT in cninfo = 0`). The 606 cninfo-only by prefix: `00` 154, `30` 44, `60` 148, `68` 4, `83` 181, `87` 54, `43` 16, `92` 5 ⇒ **256 北交所 + 350 delisted/ST** (281 of the 606 contain ST/退). ST/退 total in the 6181 = 483. Sina `hs_a` *does* include 350 BJ (`bj920000 安徽凤凰`); `node=hs_bjs` returns the same 350. Other counts: `sh_a` 2319, `sz_a` 2906.
`https://hq.sinajs.cn/list=sh600519,sz000001` works (GBK, `var hq_str_sh600519="贵州茅台,1286.000,…"`) but **node ids are not quotable** (`list=gn_hwqc` → `var hq_str_gn_hwqc="";`).

---

## GOAL D — pinyin search

npm registry **reachable**: `npm view pinyin-pro version` → **3.29.5**; install in the temp dir exit 0.
Exports: `OutputFormat, addDict, addTraditionalDict, clearCustomDict, convert, customPinyin, getFinalParts, getInitialAndFinal, getNumOfTone, getTraditionalDict, html, match, pinyin, polyphonic, removeDict, segment` — there is **no `htmlToPinyin`** (the helper is `html`).

Canonical calls:
```js
import { pinyin, match } from 'pinyin-pro';
const full     = (s) => pinyin(s, { toneType: 'none', type: 'string', separator: '' });   // guizhoumaotai
const fullArr  = (s) => pinyin(s, { toneType: 'none', type: 'array' });                    // ['gui','zhou','mao','tai']
const initials = (s) => pinyin(s, { pattern: 'first', toneType: 'none', type: 'string', separator: '' }); // gzmt
```

| input | full array | full | initials |
|---|---|---|---|
| 贵州茅台 | `["gui","zhou","mao","tai"]` | `guizhoumaotai` | `gzmt` |
| 中国平安 | `["zhong","guo","ping","an"]` | `zhongguopingan` | `zgpa` |
| 宁德时代 | `["ning","de","shi","dai"]` | `ningdeshidai` | `ndsd` |
| 比亚迪 | `["bi","ya","di"]` | `biyadi` | `byd` |
| 招商银行 | `["zhao","shang","yin","hang"]` | `zhaoshangyinhang` | `zsyh` |
| `*ST泛海` | `["*","S","T","fan","hai"]` | `*STfanhai` | `*STfh` |
| `C零芯` | `["C","ling","xin"]` | `Clingxin` | `Clx` |
| 富春股份 | `["fu","chun","gu","fen"]` | `fuchungufen` | `fcgf` |
| `301052` | digits pass through | `301052` | `301052` |
| `688573` | digits pass through | `688573` | `688573` |

Also verified: `{toneType:'symbol',type:'string'}` on 贵州茅台 → `guì zhōu máo tái`; `{nonZh:'removed'}` on `*ST泛海` → `fan hai`, `{nonZh:'consecutive'}` → `*ST fan hai`; polyphones are correct by default (重庆钢铁 → `chong qing gang tie`, 招商银行 → `zhao shang yin hang`, 单长江 → `dan chang jiang`); `{mode:'surname',surname:'all'}` → 单长江 `shan chang jiang`; `type:'all'` gives per-character `{origin,pinyin,initial,final,first,isZh,polyphonic,inZhRange,result}` (`.initial` keeps `zh/sh/ch` digraphs).
**Initials API = `pinyin(name,{pattern:'first',toneType:'none',type:'string',separator:''})`.** `getInitialAndFinal(str)` takes a **string** and returns `{initial,final}` *with diacritics and multi-char initials* (贵州茅台 → `{initial:"g zh m t", final:"uì ōu áo ái"}`); passing an array throws `TypeError: pinyin.split is not a function` at `pinyin-pro/dist/esm/core/pinyin/handle.mjs:126`. `convert(arr,'first','string')` returns an **array** for array input (string for string input) — counter-intuitive; prefer the `pinyin(..., {pattern:'first'})` form.
`match(text, pinyin, opts)` — **argument order is (TEXT, PINYIN)**; the reversed order throws `TypeError: pinyin.toLowerCase is not a function` at `pinyin-pro/dist/esm/core/match/index.mjs:55`. Signature `(text, pinyin, {precision:'first'|'start'|'every'|'any', continuous?, space?, lastPrecision?, insensitive?, v?}) => number[]|null`.
Verified: `match('贵州茅台','guizhoumaotai')`=[0,1,2,3] · `('贵州茅台','gzmt')`=[0,1,2,3] · `('贵州茅台','maotai')`=[2,3] · `('贵州茅台','mt',{precision:'first',continuous:true})`=[2,3] · `('*ST泛海','stfh',{precision:'first'})`=[1,2,3,4].

Whole-market perf: **6181 names → full + initials index in 95 ms (0.015 ms/name)**, JSON 552,753 B (`_pinyin_index.json`).
**Initial collisions: 847 groups covering 2338 stocks** (worst `ylgf` = 13, incl. 600887 伊利股份; `zykj` = 12; `hxkj` = 12) ⇒ initials alone are not unique; rank exact-initial matches above prefix matches.
My initials differ from cninfo's own `pinyin` field in **204/6181** cases — all `*ST` names, where mine keeps the `*` (`*stsw`) and cninfo drops it (`stsw`).
Search demo: `gzmt`→600519 贵州茅台 · `zgpa`→601318 中国平安 · `ndsd`→300750 宁德时代 · `byd`→002594 比亚迪 · `zsyh`→600036 招商银行 + 601916 浙商银行 · `301052`→301052 果麦文化.
Correction: the task's expectation `fcgf → 300283` is wrong — 300283 is 温州宏丰; `fcgf` correctly resolves to **300299 富春股份**.
Also works: `customPinyin({长盈精密:'chang ying jing mi'})`, `html('<b>贵州茅台</b> sh600519',{toneType:'none'})`.

---

## Artifacts in `D:\DeepSeek harness\.tmp-probe-news\`
`_lib.mjs` (UA, `req(url,opts)`, `snip`, `paths`, `times(n,fn)` → `{first,res}` where `res` is an array of **strings**) · `goalA.mjs goalA2.mjs goalA3.mjs goalB.mjs goalB3.mjs goalB4.mjs goalC.mjs goalC4.mjs goalC6.mjs goalC7.mjs goalC8.mjs goalD.mjs goalD3.mjs universe.mjs` · data `_universe.json` (9062 rows `{code,name,pinyin,orgId,category}`) `_sina_all_ids.json` (1970 ids) `_tx_gn_boards.json` (800) `_pinyin_index.json` `_pinyin_results.json`.
