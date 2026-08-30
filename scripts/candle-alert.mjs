#!/usr/bin/env node
/**
 * 蜡烛图买卖信号 → Telegram 提醒
 *
 * 策略（第九轮回测出的组合，8只科技巨头 2024-08 至 2026-08 全部盈利）：
 *   买入 G3 影线不对称：x = ((min(o,c)-l) - (h-max(o,c))) / (h-l)
 *                       r = x 在最近60根日线里的分位
 *                       r >= 0.80 → 次日开盘做多 ; r <= 0.20 → 次日开盘做空
 *   卖出 G8 跳空：      y = (今开 - 昨收) / 昨收
 *                       r = y 在最近60根日线里的分位
 *                       持多仓 & r <= 0.20 → 次日开盘平仓
 *                       持空仓 & r >= 0.80 → 次日开盘平仓
 *   安全阀：任何持仓浮亏到 8% 立即离场
 *
 * 无状态设计：每次运行都从两年历史完整重放一遍，推导出当前持仓。
 * 不需要数据库、不需要 commit 状态文件，中断几天再跑也会自动回到正确状态。
 */

// ── 参数（与回测完全一致，勿随意改动）───────────────────────────────
const TICKERS   = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'GOOGL', 'AMZN'];
const WIN       = 60;      // 分位回看窗口（交易日）
const HI        = 0.80;    // 上分位阈值
const LO        = 0.20;    // 下分位阈值
const STOP      = 0.08;    // 8% 固定止损
const NEAR_STOP = 0.06;    // 浮亏超过 6% 就在盘中提醒「接近止损」
const ALLOW_SHORT = (process.env.ALLOW_SHORT ?? '1') !== '0';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const QUIET_INTRADAY = process.env.QUIET_INTRADAY === '1';  // 盘中无事则不发
const DRY_RUN  = process.env.DRY_RUN === '1';

// ── 美东时间工具 ──────────────────────────────────────────────────
function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return {
    date: `${f.year}-${f.month}-${f.day}`,
    hour: +f.hour % 24, minute: +f.minute, wd: f.weekday,
    hhmm: `${f.hour}:${f.minute}`,
  };
}

// 2026–2027 美股休市日（NYSE/Nasdaq）
const HOLIDAYS = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19',
  '2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18',
  '2027-07-05','2027-09-06','2027-11-25','2027-12-24',
]);
const isTradingDay = (et) =>
  !['Sat', 'Sun'].includes(et.wd) && !HOLIDAYS.has(et.date);

/** 下一个交易日（跳过周末与假日） */
function nextTradingDay(et) {
  const d = new Date(`${et.date}T12:00:00Z`);
  for (let i = 0; i < 12; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    if (!['Sat', 'Sun'].includes(wd) && !HOLIDAYS.has(iso)) return { date: iso, wd };
  }
  return null;
}
const WD_CN = { Mon: '\u5468\u4e00', Tue: '\u5468\u4e8c', Wed: '\u5468\u4e09', Thu: '\u5468\u56db',
                Fri: '\u5468\u4e94', Sat: '\u5468\u516d', Sun: '\u5468\u65e5' };

/** 根据美东时间判断这一跑属于哪个时段 */
function session(et) {
  const m = et.hour * 60 + et.minute;
  // 休市日（周末 / 假日）：一天只在这一个窗口播报一次
  if (!isTradingDay(et)) {
    return (m >= 10 * 60 && m < 11 * 60 + 30) ? 'CLOSED' : null;  // 10:00\u201311:29
  }
  // 交易日：窗口刻意做窄：同一个时段写两个 UTC cron（兼容夏令时/冬令时），
  // 只有落在窗口内的那一次会真的发消息，另一次自动退出。
  if (m >= 8 * 60 + 15 && m < 9 * 60 + 30)   return 'PRE';   // 08:15\u201309:29 \u76d8\u524d
  if (m >= 12 * 60 + 10 && m < 13 * 60 + 20) return 'MID';   // 12:10\u201313:19 \u76d8\u4e2d
  if (m >= 16 * 60 + 10 && m < 17 * 60 + 20) return 'POST';  // 16:10\u201317:19 \u76d8\u540e
  return null;
}

// ── 取数：Yahoo 主源 + Twelve Data 备源 ───────────────────────────
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TD_KEY = process.env.TWELVEDATA_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);

let COOKIE = '';
let CRUMB = '';
/** 先拿 Yahoo 的 cookie + crumb —— 期权链接口强制要 crumb，行情接口也更不容易被限流 */
async function warmup() {
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    const sc = r.headers.getSetCookie?.() ?? [];
    COOKIE = sc.map((c) => c.split(';')[0]).join('; ');
  } catch { /* 拿不到就算了 */ }
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: YH_HEADERS() });
    const t = (await r.text()).trim();
    if (t && t.length <= 40 && !t.startsWith('{')) CRUMB = t;
  } catch { /* 同上 */ }
  console.log(`Yahoo 握手：cookie ${COOKIE ? '有' : '无'} · crumb ${CRUMB ? '有' : '无'}`);
}

const YH_HEADERS = () => ({
  'User-Agent': UA,
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  ...(COOKIE ? { Cookie: COOKIE } : {}),
});

/** 单次 Yahoo 请求，内部小步重试；429 会按 Retry-After 等待 */
async function yahoo(path, tries = 2, base = 2500) {
  let last;
  for (let a = 0; a < tries; a++) {
    const host = HOSTS[a % HOSTS.length];
    const url = `https://${host}${path}`
              + (CRUMB ? (path.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(CRUMB)}` : '');
    try {
      const res = await fetch(url, { headers: YH_HEADERS() });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
      if (res.status === 404) throw last;                       // 代码写错了，重试没用
      const ra = Number(res.headers.get('retry-after')) || 0;
      if (a < tries - 1) await sleep(Math.max(ra * 1000, jitter(base * (a + 1))));
    } catch (e) {
      last = e;
      if (String(e.message).includes('404')) throw e;
      if (a < tries - 1) await sleep(jitter(base * (a + 1)));
    }
  }
  throw last;
}

const toBars = (r) => {
  const q = r.indicators.quote[0], out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if ([o, h, l, c].some((v) => v == null || !isFinite(v))) continue;
    out.push({ t: r.timestamp[i], o, h, l, c,
      d: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
           .format(new Date(r.timestamp[i] * 1000)) });
  }
  return out;
};

async function fetchDailyYahoo(ticker, range = '2y') {
  const j = await yahoo(`/v8/finance/chart/${ticker}`
                      + `?range=${range}&interval=1d&includePrePost=false`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description ?? '无数据');
  return toBars(r);
}

/** 认证/代码错误这类重试也没用的错误，标记出来直接放弃，不要空转 */
class Fatal extends Error { constructor(m) { super(m); this.fatal = true; } }

/** Twelve Data：免费 key 即可。限流按 key 计，不受 GitHub 服务器 IP 影响 */
async function fetchDailyTD(ticker, tries = 3, out = 600) {
  if (!TD_KEY) throw new Fatal('未配置 TWELVEDATA_API_KEY');
  const SC = Number(process.env.RETRY_SCALE || 1);
  const u = `https://api.twelvedata.com/time_series?symbol=${ticker}`
          + `&interval=1day&outputsize=${out}&apikey=${TD_KEY}`;
  let last;
  for (let a = 0; a < tries; a++) {
    let j, status;
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA } });
      status = res.status; j = await res.json();
    } catch (e) {
      last = e;
      if (a < tries - 1) await sleep(jitter(3000 * (a + 1) * SC));
      continue;
    }
    if (j.status === 'ok' && Array.isArray(j.values)) {
      const bars = j.values.slice().reverse().map((v) => ({    // 返回是新→旧，要反过来
        d: v.datetime,
        t: Math.floor(Date.parse(`${v.datetime}T16:00:00-04:00`) / 1000),
        o: +v.open, h: +v.high, l: +v.low, c: +v.close,
      })).filter((b) => [b.o, b.h, b.l, b.c].every(isFinite));
      if (bars.length) return bars;
      throw new Fatal('返回空数据');
    }
    const code = j.code ?? status;
    const msg = `${code}: ${String(j.message ?? '').slice(0, 70)}`;
    if ([401, 403, 404, 400].includes(code)) throw new Fatal(msg);   // key 错 / 代码错，重试无用
    last = new Error(msg);
    if (code === 429 && a < tries - 1) { await sleep(62000 * SC); continue; }  // 每分钟额度用完
    if (a < tries - 1) await sleep(jitter(3000 * (a + 1) * SC));
  }
  throw last;
}

/**
 * 串行取数。主源分三轮重试（打不通就等一会儿再打），最后还缺的交给备源。
 * 只要有一只成功就照常发消息，不会因为个别失败整个任务红叉。
 *
 * DATA_SOURCE = auto      配了 TD key 就用 TD 打头、Yahoo 兜底；没配就只用 Yahoo（默认）
 *             = twelvedata 强制 TD 打头
 *             = yahoo      强制 Yahoo 打头
 */
function sources() {
  const mode = (process.env.DATA_SOURCE || 'auto').toLowerCase();
  const tdFirst = mode === 'twelvedata' || (mode === 'auto' && !!TD_KEY);
  const SC = Number(process.env.RETRY_SCALE || 1);
  const S = {
    yahoo:      { name: 'Yahoo',      fn: fetchDailyYahoo, gap: 1500 * SC, warm: true,
                  short: (t) => fetchDailyYahoo(t, '8mo') },
    twelvedata: { name: 'TwelveData', fn: fetchDailyTD,    gap: 8000 * SC, warm: false,
                  short: (t) => fetchDailyTD(t, 3, 180) },
  };
  return { primary: tdFirst ? S.twelvedata : S.yahoo,
           backup:  tdFirst ? S.yahoo : (TD_KEY ? S.twelvedata : null) };
}

async function fetchAll(tickers) {
  const SC = Number(process.env.RETRY_SCALE || 1);
  const { primary, backup } = sources();
  console.log(`主源 ${primary.name}${backup ? ` · 备源 ${backup.name}` : ' · 无备源'}`);

  const bars = {}, errs = {};
  let warmed = false, working = null;
  const pass = async (src, list, gapMul = 1) => {
    if (src.warm && !warmed) { await warmup(); warmed = true; }
    let fatal = 0;
    for (const t of list) {
      try { bars[t] = await src.fn(t); delete errs[t]; working = src; }
      catch (e) { errs[t] = `${src.name} ${e.message}`; if (e.fatal) fatal++; }
      await sleep(jitter(src.gap * gapMul));
    }
    return { got: list.filter((t) => bars[t]).length, fatal };
  };

  // 第 1 轮主源
  let r1 = await pass(primary, tickers);
  // 主源一只都没成 → 别再空转，直接切备源
  const bail = r1.got === 0;
  if (bail && backup) console.log(`${primary.name} 整批失败${r1.fatal ? '（配置错误）' : ''}，直接切 ${backup.name}`);

  if (!bail) {
    for (const [i, wait] of [30000 * SC, 60000 * SC].entries()) {
      const todo = tickers.filter((t) => !bars[t]);
      if (!todo.length) break;
      console.log(`还差 ${todo.join('/')} —— 等 ${wait / 1000}s 再试`);
      await sleep(wait);
      await pass(primary, todo, 1.6 + i);
    }
  }

  if (backup) {
    const todo = tickers.filter((t) => !bars[t]);
    if (todo.length) {
      const before = Object.keys(bars).length;
      await pass(backup, todo);
      const got = Object.keys(bars).length - before;
      if (got) console.log(`备源 ${backup.name} 补上 ${got} 只`);
    }
  }
  return { bars, errs, working: working ?? primary };
}

/** 盘中实时报价（用于止损监控）—— 取不到就跳过，不影响主消息 */
async function fetchQuote(ticker) {
  let j;
  try { j = await yahoo(`/v8/finance/chart/${ticker}?range=1d&interval=1m`, 2, 1500); }
  catch { return null; }
  const r = j?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta) return null;
  const q = r.indicators?.quote?.[0] ?? {};
  const lows = (q.low ?? []).filter((v) => v != null);
  const highs = (q.high ?? []).filter((v) => v != null);
  return {
    price: meta.regularMarketPrice,
    dayLow: lows.length ? Math.min(...lows) : meta.regularMarketDayLow,
    dayHigh: highs.length ? Math.max(...highs) : meta.regularMarketDayHigh,
    prevClose: meta.chartPreviousClose,
  };
}

// ── 扫描：从热股榜里找新机会 ──────────────────────────────────────
const SCAN = {
  on:       (process.env.SCAN_ENABLE ?? '1') !== '0',
  detail:    Number(process.env.SCAN_DETAIL    || 3),     // 前几名给完整期权分析，其余一行带过
  sessions: (process.env.SCAN_SESSIONS || 'PRE,CLOSED').split(',').map((x) => x.trim()),
  top:       Number(process.env.SCAN_TOP       || 10),    // 按成交额取前几名
  minPrice:  Number(process.env.SCAN_MIN_PRICE || 10),    // 股价门槛（宽松）
  minDolVol: Number(process.env.SCAN_MIN_DOLVOL|| 0),     // 成交额门槛，0=不限
  pool:      Number(process.env.SCAN_POOL      || 50),    // 从榜单前多少名里筛
};
// 回测里这套规则成立的区间：日成交额 ≥$2B 且 股价 ≥$50 的 10 只全部盈利，
// 低于这个区间的 6 只全部亏损。切点是看了结果画的（n=16），只当参考不当定律。
const SAFE = { dolVol: 2e9, price: 50 };

/** Yahoo 成交最活跃榜，然后按「成交额」重排（原榜是按股数，会全是低价股） */
async function fetchMovers() {
  const j = await yahoo('/v1/finance/screener/predefined/saved'
                      + `?scrIds=most_actives&count=${SCAN.pool}&formatted=false`, 2, 2000);
  const q = j?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(q) || !q.length) throw new Error('榜单为空');
  return q
    .map((x) => ({ sym: x.symbol, px: x.regularMarketPrice, vol: x.regularMarketVolume,
                   mcap: x.marketCap, chg: x.regularMarketChangePercent,
                   dv: (x.regularMarketPrice || 0) * (x.regularMarketVolume || 0) }))
    .filter((x) => x.sym && /^[A-Z.]{1,6}$/.test(x.sym)      // 排除期权/权证之类的怪代码
                && x.px >= SCAN.minPrice && x.dv >= SCAN.minDolVol
                && !TICKERS.includes(x.sym))                  // 固定名单里的已经在跟了
    .sort((a, b) => b.dv - a.dv)
    .slice(0, SCAN.top);
}

/** 对榜单里的每只股票算 G3 买入信号，返回今天有信号的 */
async function scanHits(movers, fetchFn, gap) {
  const hits = [], failed = [];
  for (const m of movers) {
    try {
      const bars = await fetchFn(m.sym);
      if (bars.length < WIN + 5) { failed.push(`${m.sym}(数据不足)`); continue; }
      const sig = signals(bars);
      const last = sig[sig.length - 1];
      if (last.buy !== 0) {
        hits.push({ ...m, dir: last.buy, xr: last.xr, bars,
                    rv: realizedVol(bars), gap: gapTrigger(bars),
                    lastBar: bars[bars.length - 1],
                    safe: m.dv >= SAFE.dolVol && m.px >= SAFE.price });
      }
    } catch (e) { failed.push(`${m.sym}(${String(e.message).slice(0, 30)})`); }
    await sleep(jitter(gap));
  }
  return { hits, failed };
}

// ── 期权：从信号选一张具体合约 ────────────────────────────────────
const OPT = {
  on:        (process.env.OPTION_ENABLE ?? '1') !== '0',
  dteMin:    Number(process.env.OPTION_DTE_MIN    || 7),
  dteMax:    Number(process.env.OPTION_DTE_MAX    || 14),
  dteWant:   Number(process.env.OPTION_DTE_TARGET || 11),
  delta:     Number(process.env.OPTION_DELTA      || 0.55),   // 目标 delta，0.5≈平值
  minOI:     Number(process.env.OPTION_MIN_OI     || 200),
  maxSpread: Number(process.env.OPTION_MAX_SPREAD || 0.15),   // (卖价-买价)/中间价
  budget:    Number(process.env.OPTION_BUDGET     || 500),    // 每笔想投多少美元
};

// 回测里 475 笔交易的标的表现，用来和期权的回本门槛做对比
const HIST = {
  avg: 0.0086, med: 0.0008, win: 0.0498, loss: -0.0347, wr: 0.512,   // 标的每笔表现
  holdMed: 3, holdP90: 11,                                            // 持仓交易日
  // 把这 475 笔换成 11 天期 delta≈0.55 期权的回测结果（IV 按实际波动×1.15）
  optAvg: 0.152, optMed: -0.175, optWr: 0.398, optNoise: 0.074,
};

const ncdf = (x) => {                                   // 标准正态累积分布
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (1.330274429 * t ** 4 - 1.821255978 * t ** 3
                   + 1.781477937 * t * t - 0.356563782 * t + 0.319381530);
  return x > 0 ? 1 - p : p;
};
const bs = (S, K, T, v, call) => {                      // Black-Scholes（无风险利率按 4%）
  if (T <= 0) return { px: Math.max(0, call ? S - K : K - S), delta: call ? (S > K ? 1 : 0) : (S < K ? -1 : 0) };
  const r = 0.04, sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / sq, d2 = d1 - sq;
  const px = call ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2)
                  : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
  return { px, delta: call ? ncdf(d1) : ncdf(d1) - 1 };
};

/** 挑一张合约：先选到期日，再在该到期日里选最接近目标 delta 的流动合约 */
async function pickOption(ticker, dir, spotHint) {
  const call = dir === 1;
  const a = await yahoo(`/v7/finance/options/${ticker}`, 2, 2000);
  const r0 = a?.optionChain?.result?.[0];
  if (!r0?.expirationDates?.length) throw new Error('拿不到到期日列表');
  const now = Date.now() / 1000;
  const cand = r0.expirationDates
    .map((e) => ({ e, dte: Math.round((e - now) / 86400) }))
    .filter((c) => c.dte >= OPT.dteMin && c.dte <= OPT.dteMax);
  if (!cand.length) throw new Error(`${OPT.dteMin}~${OPT.dteMax} 天内没有到期日`);
  const exp = cand.sort((x, y) => Math.abs(x.dte - OPT.dteWant) - Math.abs(y.dte - OPT.dteWant))[0];

  await sleep(jitter(1200));
  const b = await yahoo(`/v7/finance/options/${ticker}?date=${exp.e}`, 2, 2000);
  const r = b?.optionChain?.result?.[0];
  const leg = r?.options?.[0]?.[call ? 'calls' : 'puts'] ?? [];
  const S = r?.quote?.regularMarketPrice ?? spotHint;
  if (!leg.length || !S) throw new Error('期权链为空');

  const T = exp.dte / 365;
  const rows = leg.map((c) => {
    const mid = (c.bid + c.ask) / 2;
    const spread = mid > 0 ? (c.ask - c.bid) / mid : 9;
    const iv = c.impliedVolatility;
    const d = iv > 0 ? bs(S, c.strike, T, iv, call).delta : NaN;
    return { ...c, mid, spread, iv, d };
  }).filter((c) => c.bid > 0 && c.ask > 0 && isFinite(c.d)
                && c.openInterest >= OPT.minOI && c.spread <= OPT.maxSpread);
  if (!rows.length) throw new Error('没有满足流动性要求的合约');

  const best = rows.sort((x, y) => Math.abs(Math.abs(x.d) - OPT.delta)
                                 - Math.abs(Math.abs(y.d) - OPT.delta))[0];
  const cost = best.ask * 100;                          // 按卖价买入，最保守
  const n = Math.max(1, Math.floor(OPT.budget / cost));
  const be = call ? (best.strike + best.ask) / S - 1 : 1 - (best.strike - best.ask) / S;

  // 情景：持有到回测的中位持仓天数（3 个交易日 ≈ 4 个自然日）后，标的走 x% 时这张合约值多少
  const Th = Math.max(0, (exp.dte - 4)) / 365;
  const scen = [HIST.win, HIST.avg, 0, HIST.loss, -0.08].map((m) => {
    const S2 = S * (1 + (call ? m : -m));               // 做空时标的下跌才有利
    const v = bs(S2, best.strike, Th, best.iv, call).px;
    return { m, opt: v / best.ask - 1 };
  });
  return { exp, dte: exp.dte, S, c: best, cost, n, be, scen, call,
           expDate: new Date(exp.e * 1000).toISOString().slice(0, 10) };
}

// ── 指标 ─────────────────────────────────────────────────────────
/** 最近 WIN 根里，有多少比例的历史值严格小于当前值（与回测的 rolling.apply 一致） */
function pctRank(arr, i) {
  if (i < WIN - 1) return null;
  const cur = arr[i];
  if (cur == null || !isFinite(cur)) return null;
  let lt = 0, n = 0;
  for (let k = i - WIN + 1; k < i; k++) {
    const v = arr[k];
    if (v == null || !isFinite(v)) return null;   // 窗口内有 NaN → 分位为 NaN
    n++; if (v < cur) lt++;
  }
  return n ? lt / n : null;
}
const thr = (r) => (r == null ? 0 : r >= HI ? 1 : r <= LO ? -1 : 0);

/** 返回每根K线的 {buy, sell} 信号（-1 / 0 / +1） */
function signals(bars) {
  const n = bars.length;
  const x = new Array(n), y = new Array(n);
  for (let i = 0; i < n; i++) {
    const { o, h, l, c } = bars[i];
    const rng = h - l;
    x[i] = rng === 0 ? NaN : ((Math.min(o, c) - l) - (h - Math.max(o, c))) / rng;
    y[i] = i === 0 ? NaN : (o - bars[i - 1].c) / bars[i - 1].c;
  }
  return bars.map((_, i) => ({
    buy:  thr(pctRank(x, i)),
    sell: thr(pctRank(y, i)),
    xr:   pctRank(x, i),
    yr:   pctRank(y, i),
  }));
}

/**
 * 算出「下一个交易日开盘价落在什么位置，会让 G8 跳空信号触发」。
 * 因为 G8 只用到今开与昨收，所以它是唯一能提前折算成一个具体价位的信号。
 * 注意：在第 i 根触发的信号，是在第 i+1 根的开盘执行 —— 所以是「后天开盘动手」。
 */
function gapTrigger(bars) {
  const n = bars.length;
  const w = [];
  for (let i = n - WIN + 1; i < n; i++) {           // 最近 WIN-1 = 59 个历史值
    if (i < 1) return null;
    const v = (bars[i].o - bars[i - 1].c) / bars[i - 1].c;
    if (!isFinite(v)) return null;
    w.push(v);
  }
  if (w.length < WIN - 1) return null;
  const sorted = [...w].sort((a, b) => a - b);
  const prev = bars[n - 1].c;
  const kUp = Math.ceil(HI * w.length);             // 需要至少这么多历史值小于它
  const kDn = Math.floor(LO * w.length);            // 最多只能有这么多历史值小于它
  // 取整到分：向外各让一档，让「≥ / ≤ 这个报价」一定落在触发区间内
  return {
    up:   Math.ceil(prev * (1 + sorted[kUp - 1]) * 100) / 100,   // 开盘 ≥ 此价 → 触发 +1
    down: Math.floor(prev * (1 + sorted[kDn]) * 100) / 100,      // 开盘 ≤ 此价 → 触发 -1
    prev,
  };
}

// ── 重放持仓状态（与 Python 回测 run() 逐行等价）──────────────────
/** 近 n 日年化实际波动率，用来判断期权贵不贵 */
function realizedVol(bars, n = 60) {
  const r = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++)
    r.push(Math.log(bars[i].c / bars[i - 1].c));
  if (r.length < 20) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return sd * Math.sqrt(252);
}

function replay(bars, sig) {
  let pos = 0, ep = 0, epDate = null, pend = 0, trades = 0, wins = 0, eq = 1;
  const cost = 0.0005;
  const close = (px) => {
    const r = (pos === 1 ? px / ep - 1 : 1 - px / ep) - 2 * cost;
    eq *= 1 + r; trades++; if (r > 0) wins++;
    pos = 0; ep = 0; epDate = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // 1. 执行昨日挂单（今日开盘）
    if (pend !== 0 && pend !== -99 && pos === 0) { pos = pend; ep = b.o; epDate = b.d; pend = 0; }
    else if (pend === -99 && pos !== 0) { close(b.o); pend = 0; }
    else pend = 0;
    // 2. 盘中止损
    if (pos !== 0) {
      const hit = pos === 1 ? b.l <= ep * (1 - STOP) : b.h >= ep * (1 + STOP);
      if (hit) { eq *= 1 - STOP - 2 * cost; trades++; pos = 0; ep = 0; epDate = null; continue; }
    }
    // 3. 生成明日挂单
    if (pos === 0) {
      if (sig[i].buy !== 0 && (ALLOW_SHORT || sig[i].buy === 1)) pend = sig[i].buy;
    } else if (sig[i].sell === -pos) pend = -99;
  }
  return { pos, ep, epDate, pend, trades, wins, eq };
}

// ── 文案 ─────────────────────────────────────────────────────────
const money = (v) => (v == null ? '—' : v.toFixed(2));
const pct   = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
const esc   = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirCN = (p) => (p === 1 ? '多头' : '空头');
const stopPx = (s) => (s.pos === 1 ? s.ep * (1 - STOP) : s.ep * (1 + STOP));

function triggerLine(t, s) {
  const g = s.gap;
  if (!g) return null;
  if (s.pos === 1)  return `<code>${t.padEnd(5)}</code> \u591a\u5934 \u2192 \u5f00\u76d8 <b>\u2264 ${money(g.down)}</b> \u5219\u53d1\u51fa\u5e73\u4ed3\u4fe1\u53f7`;
  if (s.pos === -1) return `<code>${t.padEnd(5)}</code> \u7a7a\u5934 \u2192 \u5f00\u76d8 <b>\u2265 ${money(g.up)}</b> \u5219\u53d1\u51fa\u5e73\u4ed3\u4fe1\u53f7`;
  return null;
}

function actionLine(t, s) {
  if (s.pend === -99) return `⬜️ <b>${t}</b> 开盘 <b>平仓</b>（当前${dirCN(s.pos)} @ ${money(s.ep)}）`;
  if (s.pend === 1)   return `🟢 <b>${t}</b> 开盘 <b>做多</b>`;
  if (s.pend === -1)  return `🔴 <b>${t}</b> 开盘 <b>做空</b>`;
  return null;
}

function holdLine(t, s, live) {
  const sp = stopPx(s);
  let pl = '';
  if (live?.price) {
    const r = s.pos === 1 ? live.price / s.ep - 1 : 1 - live.price / s.ep;
    pl = ` · 现价 ${money(live.price)} <b>${pct(r)}</b>`;
  }
  return `${s.pos === 1 ? '📈' : '📉'} <b>${t}</b> ${dirCN(s.pos)} @ ${money(s.ep)}`
       + ` (${s.epDate}) · 止损 ${money(sp)}${pl}`;
}

// ── 主流程 ───────────────────────────────────────────────────────
function optionBlock(t, s, o, brief = false) {
  if (!o) return null;
  const c = o.c, side = o.call ? 'CALL' : 'PUT';
  if (brief) {
    return `　└ <b>${o.expDate.slice(5)} ${side} ${c.strike}</b>`
         + `　$${o.cost.toFixed(0)}/张　delta ${Math.abs(c.d).toFixed(2)}`
         + `　回本${o.call ? '涨' : '跌'} ${(Math.abs(o.be) * 100).toFixed(1)}%`
         + `　IV ${(c.iv * 100).toFixed(0)}%`;
  }
  const ivTxt = s.rv
    ? `IV ${(c.iv * 100).toFixed(0)}% vs 近60日实际 ${(s.rv * 100).toFixed(0)}%`
      + (c.iv > s.rv * 1.1 ? ' <b>(偏贵)</b>' : c.iv < s.rv * 0.9 ? ' (偏便宜)' : ' (合理)')
    : `IV ${(c.iv * 100).toFixed(0)}%`;
  const L = [
    `　└ <b>${t} ${o.expDate} ${side} ${c.strike}</b>　${o.dte}天到期`,
    `　　买/卖 ${money(c.bid)} / ${money(c.ask)}　delta ${Math.abs(c.d).toFixed(2)}　${ivTxt}`,
    `　　成本 <b>$${o.cost.toFixed(0)}/张</b>　预算 $${OPT.budget} → <b>${o.n} 张</b>`
      + `${o.cost > OPT.budget ? ' <b>(超预算，这一张就超了)</b>' : ''}　未平仓 ${c.openInterest}`,
    `　　回本需${o.call ? '涨' : '跌'} <b>${(Math.abs(o.be) * 100).toFixed(2)}%</b>`
      + `　<i>(回测里平均每笔只走 ${(HIST.avg * 100).toFixed(2)}%)</i>`,
    `　　<i>持有 ${HIST.holdMed} 天后，标的走多少 → 这张的盈亏：</i>`,
  ];
  const tag = new Map([[HIST.win, '赢单均值'], [HIST.avg, '全部均值'], [0, '不动'],
                       [HIST.loss, '输单均值'], [-0.08, '打止损']]);
  for (const x of o.scen) {
    const mv = o.call ? x.m : -x.m;                    // 显示标的真实涨跌方向
    const p = x.opt * 100;
    L.push(`　　<code>标的 ${(mv >= 0 ? '+' : '') + (mv * 100).toFixed(2)}% `
         + `${(tag.get(x.m) ?? '').padEnd(4)} → 期权 ${(p >= 0 ? '+' : '') + p.toFixed(0)}%</code>`);
  }
  return L.join('\n');
}

const OPT_FOOT = `<i>期权回测：这类合约每笔均值 ${(HIST.optAvg * 100).toFixed(0)}%、中位 `
  + `${(HIST.optMed * 100).toFixed(0)}%、胜率 ${(HIST.optWr * 100).toFixed(0)}%；`
  + `但随机入场配同样的离场规则也有 ${(HIST.optNoise * 100).toFixed(0)}%，差距不显著。</i>`;

function scanBlock(scan, opts) {
  if (!scan) return [];
  const { hits, failed, n } = scan;
  const L = ['', `<u>🔍 热股扫描</u>　<i>(成交额前 ${n} 名，固定名单以外)</i>`];
  if (!hits.length) {
    L.push('　无 —— 今天没扫到新机会。');
  } else {
    for (const [i, h] of hits.entries()) {
      const dir = h.dir === 1 ? '🟢 <b>做多</b>' : '🔴 <b>做空</b>';
      const zone = h.safe ? '' : '　<b>⚠️ 验证区外</b>';
      L.push(`${dir} <b>${h.sym}</b>　$${money(h.px)}`
           + `　成交额 $${(h.dv / 1e9).toFixed(1)}B`
           + `　影线分位 ${h.xr.toFixed(3)}`
           + (h.rv ? `　波动 ${(h.rv * 100).toFixed(0)}%` : '') + zone);
      const ob = optionBlock(h.sym, h, opts[h.sym], i >= SCAN.detail);
      if (ob) L.push(ob);
    }
    if (hits.some((h) => !h.safe)) {
      L.push(`　<i>⚠️ 标记「验证区外」= 成交额 &lt;$${SAFE.dolVol / 1e9}B 或 股价 &lt;$${SAFE.price}。`
           + `回测里这类股票 6/6 全部亏损（平均 0.91x，胜率 40.6%）。</i>`);
    }
  }
  if (failed?.length) {
    const show = failed.slice(0, 4).join(', ') + (failed.length > 4 ? ` 等 ${failed.length} 只` : '');
    L.push(`　<i>未能检查：${esc(show)}</i>`);
  }
  return L;
}

/** 「开盘要做的事」为空时的说明：区分「没信号」和「功能没开」 */
function noActionNote(states, alive) {
  const near = alive.map((t) => {
    const g = states[t].lastSig;
    if (g.xr == null) return null;
    const d = Math.min(Math.abs(g.xr - HI), Math.abs(g.xr - LO));
    return { t, xr: g.xr, d };
  }).filter(Boolean).sort((a, b) => a.d - b.d).slice(0, 2);
  const tip = near.length
    ? `　最接近的：${near.map((x) => `${x.t} ${x.xr.toFixed(3)}`).join('、')}`
    : '';
  return `　<i>没有新开仓，所以这条里没有期权推荐。${tip}</i>`;
}

function buildMessage(sess, et, states, quotes = {}, errs = [], opts = {}, scan = null) {
  const alive = TICKERS.filter((t) => states[t]);
  const held  = alive.filter((t) => states[t].pos !== 0);
  const acts = alive.map((t) => {
    const line = actionLine(t, states[t]);
    if (!line) return null;
    const ob = states[t].pend === 1 || states[t].pend === -1 ? optionBlock(t, states[t], opts[t]) : null;
    return ob ? `${line}\n${ob}` : line;
  }).filter(Boolean);

  const head = { PRE: '\u{1F514} \u76d8\u524d', MID: '\u{1F4CA} \u76d8\u4e2d',
                 POST: '\u{1F319} \u76d8\u540e', CLOSED: '\u{1F324}\ufe0f \u4f11\u5e02' }[sess];
  const nxt = nextTradingDay(et);
  const nxtCN = nxt ? `${nxt.date}\uff08${WD_CN[nxt.wd]}\uff09` : '\u4e0b\u4e00\u4e2a\u4ea4\u6613\u65e5';
  const L = [`<b>${head} \u00b7 ${et.date}${sess === 'CLOSED' ? `\uff08${WD_CN[et.wd] ?? ''}\uff09` : ` \u7f8e\u4e1c ${et.hhmm}`}</b>`, ''];
  let silent = false;

  // 信号读数表（盘后与休市共用）
  const readout = () => alive.map((t) => {
    const g = states[t].lastSig;
    const f = (v) => (v == null ? ' \u2014  ' : v.toFixed(3));
    const mk = (v) => (v == null ? '\u3000' : v >= HI ? '\u25b2' : v <= LO ? '\u25bc' : '\u3000');
    return `<code>${t.padEnd(5)} \u5f71\u7ebf ${f(g.xr)}${mk(g.xr)} \u8df3\u7a7a ${f(g.yr)}${mk(g.yr)}</code>`;
  }).join('\n');

  // 触发价区块
  const triggers = (whenCN) => {
    const ls = held.map((t) => triggerLine(t, states[t])).filter(Boolean);
    if (!ls.length) return [];
    return ['', `<u>${whenCN}\u5f00\u76d8\u7684\u5e73\u4ed3\u89e6\u53d1\u4ef7</u>\u3000<i>(\u89e6\u53d1\u5219\u518d\u4e0b\u4e00\u4e2a\u5f00\u76d8\u6267\u884c)</i>`, ls.join('\n')];
  };

  if (sess === 'CLOSED') {
    L.push(`<u>${nxtCN} \u5f00\u76d8\u8981\u505a\u7684\u4e8b</u>\u3000<i>(\u57fa\u4e8e\u6700\u8fd1\u4e00\u4e2a\u4ea4\u6613\u65e5\u7684\u6536\u76d8 K \u7ebf)</i>`);
    if (acts.length) L.push(acts.join('\n'));
    else { L.push('\u3000\u65e0 \u2014\u2014 \u5f00\u76d8\u4e0d\u52a8\u3002'); L.push(noActionNote(states, alive)); }
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>\u3000<i>(\u6309\u6700\u65b0\u6536\u76d8\u4ef7)</i>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t], quotes[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...triggers(nxtCN + ' '));
    L.push('', '<u>\u6700\u65b0\u4fe1\u53f7\u8bfb\u6570</u>\u3000<i>(\u5206\u4f4d \u22650.80 \u6216 \u22640.20 \u624d\u89e6\u53d1)</i>');
    L.push(readout());
    L.push(...scanBlock(scan, opts));

  } else if (sess === 'PRE') {
    L.push('<u>\u4eca\u5929\u5f00\u76d8\u8981\u505a\u7684\u4e8b</u>');
    if (acts.length) L.push(acts.join('\n'));
    else { L.push('\u3000\u65e0 \u2014\u2014 \u4eca\u5929\u5f00\u76d8\u4e0d\u52a8\u3002'); L.push(noActionNote(states, alive)); }
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...triggers('\u4eca\u5929'));
    L.push(...scanBlock(scan, opts));

  } else if (sess === 'MID') {
    const alerts = [];
    for (const t of held) {
      const s = states[t], q = quotes[t];
      if (!q?.price) continue;
      const r = s.pos === 1 ? q.price / s.ep - 1 : 1 - q.price / s.ep;
      const touched = s.pos === 1
        ? (q.dayLow ?? q.price) <= s.ep * (1 - STOP)
        : (q.dayHigh ?? q.price) >= s.ep * (1 + STOP);
      if (touched) alerts.push(`\u{1F6D1} <b>${t}</b> <b>\u5df2\u89e6\u53ca 8% \u6b62\u635f</b>\uff0c\u7acb\u5373\u79bb\u573a\uff08\u6210\u672c ${money(s.ep)} \u00b7 \u6b62\u635f ${money(stopPx(s))}\uff09`);
      else if (r <= -NEAR_STOP) alerts.push(`\u26a0\ufe0f <b>${t}</b> \u6d6e\u4e8f ${pct(r)}\uff0c\u903c\u8fd1\u6b62\u635f ${money(stopPx(s))}`);
    }
    if (!alerts.length && QUIET_INTRADAY) silent = true;
    L.push('<u>\u6b62\u635f\u76d1\u63a7</u>');
    L.push(alerts.length ? alerts.join('\n') : '\u3000\u65e0 \u2014\u2014 \u6240\u6709\u6301\u4ed3\u90fd\u5728\u6b62\u635f\u7ebf\u5185\u3002');
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t], quotes[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');

  } else {
    const stale = alive.filter((t) => states[t].last.d !== et.date);
    L.push('<u>\u660e\u5929\u5f00\u76d8\u8981\u505a\u7684\u4e8b</u>\u3000<i>(\u57fa\u4e8e\u4eca\u65e5\u6536\u76d8 K \u7ebf)</i>');
    if (acts.length) L.push(acts.join('\n'));
    else { L.push('\u3000\u65e0 \u2014\u2014 \u660e\u5929\u5f00\u76d8\u4e0d\u52a8\u3002'); L.push(noActionNote(states, alive)); }
    L.push('', '<u>\u4eca\u65e5\u4fe1\u53f7\u8bfb\u6570</u>\u3000<i>(\u5206\u4f4d \u22650.80 \u6216 \u22640.20 \u624d\u89e6\u53d1)</i>');
    L.push(readout());
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...triggers('\u660e\u5929'));
    L.push(...scanBlock(scan, opts));
    if (stale.length) L.push('', `<i>\u26a0\ufe0f ${stale.join('/')} \u7684\u4eca\u65e5K\u7ebf\u5c1a\u672a\u66f4\u65b0\uff0c\u8bfb\u6570\u53ef\u80fd\u662f\u4e0a\u4e00\u4ea4\u6613\u65e5\u7684\u3002</i>`);
  }

  if (errs.length) L.push('', `<i>\u26a0\ufe0f \u53d6\u6570\u5931\u8d25\uff1a${esc(errs.join('; '))}</i>`);
  if (Object.keys(opts).length) L.push('', OPT_FOOT);
  L.push('', '<i>\u5386\u53f2\u566a\u58f0\u5bf9\u7167\u663e\u793a\u8be5\u7ec4\u5408\u6709\u7ea6 15% \u6982\u7387\u662f\u968f\u673a\u4ea7\u7269\u3002\u8fd9\u662f\u76d1\u63a7\uff0c\u4e0d\u662f\u6295\u8d44\u5efa\u8bae\u3002</i>');
  return { text: L.join('\n'), silent, held, acts };
}

async function main() {
  const et = etParts();
  const forced = process.env.FORCE_SESSION;       // PRE / MID / POST，手动触发用
  const sess = forced || session(et);

  if (!forced && !sess) {
    console.log(`\u7f8e\u4e1c ${et.date} ${et.hhmm}\uff08${isTradingDay(et) ? '\u4ea4\u6613\u65e5' : '\u4f11\u5e02'}\uff09`
              + `\u4e0d\u5728\u4efb\u4f55\u63d0\u9192\u7a97\u53e3\uff0c\u8df3\u8fc7`);
    return;
  }

  const { bars: allBars, errs: fetchErrs, working } = await fetchAll(TICKERS);

  const states = {}, errs = [];
  for (const t of TICKERS) {
    const bars = allBars[t];
    if (!bars) { errs.push(`${t}(${fetchErrs[t]})`); continue; }
    if (bars.length < WIN + 5) { errs.push(`${t}(历史数据不足)`); continue; }
    const sig = signals(bars);
    const st = replay(bars, sig);
    st.last = bars[bars.length - 1];
    st.lastSig = sig[sig.length - 1];
    st.gap = gapTrigger(bars);
    st.rv = realizedVol(bars);
    states[t] = st;
  }
  const okN = Object.keys(states).length;
  if (!okN) throw new Error(`全部取数失败: ${errs.join('; ')}`);
  console.log(`取数成功 ${okN}/${TICKERS.length}${errs.length ? '，失败: ' + errs.join('; ') : ''}`);

  const quotes = {};
  const holding = TICKERS.filter((t) => states[t] && states[t].pos !== 0);
  if (sess === 'MID') {
    for (const t of holding) {                    // 串行，避免又被限流
      quotes[t] = await fetchQuote(t);
      await sleep(jitter(1200));
    }
  } else if (sess === 'CLOSED') {
    // 休市没有实时价，用最近一个交易日的收盘价来算浮盈亏
    for (const t of holding) {
      const b = states[t].last;
      quotes[t] = { price: b.c, dayLow: b.l, dayHigh: b.h, prevClose: b.c };
    }
  }

  // 热股扫描：从成交额榜里找固定名单以外、今天有买入信号的股票
  let scan = null;
  if (SCAN.on && SCAN.sessions.includes(sess)) {
    try {
      if (!CRUMB) await warmup();                 // 榜单接口也要 crumb
      const movers = await fetchMovers();
      console.log(`热股榜取到 ${movers.length} 只：${movers.map((m) => m.sym).join(' ')}`);
      // 用刚才真正取数成功的那个源，别再用打不通的主源
      const r = await scanHits(movers, working.short, working.gap);
      console.log(`扫描用 ${working.name} 取数`);
      scan = { ...r, n: movers.length };
      console.log(`扫描命中 ${r.hits.length} 只${r.failed.length ? '，失败 ' + r.failed.join(',') : ''}`);
    } catch (e) {
      errs.push(`热股扫描(${e.message})`);
    }
  }

  // 「要开仓」的股票才去选期权：固定名单里待开仓的 + 扫描命中的
  const opts = {};
  const entering = [
    ...TICKERS.filter((t) => states[t] && (states[t].pend === 1 || states[t].pend === -1))
              .map((t) => ({ sym: t, dir: states[t].pend, px: states[t].last.c })),
    ...(scan?.hits ?? []).map((h) => ({ sym: h.sym, dir: h.dir, px: h.lastBar.c })),
  ];
  if (OPT.on && entering.length) {
    if (!CRUMB) await warmup();                   // 期权链强制要 crumb
    for (const e of entering) {
      try {
        opts[e.sym] = await pickOption(e.sym, e.dir, e.px);
        console.log(`${e.sym} 选中 ${opts[e.sym].c.contractSymbol}`);
      } catch (err) {
        errs.push(`${e.sym} 期权链(${err.message})`);
      }
      await sleep(jitter(1500));
    }
  }

  const { text, silent } = buildMessage(sess, et, states, quotes, errs, opts, scan);
  if (silent && !forced) { console.log('\u76d8\u4e2d\u65e0\u5f02\u5e38\uff0c\u9759\u9ed8'); return; }
  if (DRY_RUN || !TG_TOKEN || !TG_CHAT) { console.log(text.replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')); return; }

  // Telegram 单条上限 4096 字符，超了就按行拆成多条
  const LIMIT = 3900;
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const ln = line.length > LIMIT ? line.slice(0, LIMIT - 3) + '...' : line;
    if (cur && cur.length + ln.length + 1 > LIMIT) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + ln;
  }
  if (cur) chunks.push(cur);

  for (const [i, part] of chunks.entries()) {
    const body = chunks.length > 1 ? `${part}\n\n<i>(${i + 1}/${chunks.length})</i>` : part;
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: body, parse_mode: 'HTML',
                             disable_web_page_preview: true }),
    });
    const jr = await r.json();
    if (!jr.ok) { console.error('Telegram 发送失败:', JSON.stringify(jr)); process.exit(1); }
    if (i < chunks.length - 1) await sleep(600);
  }
  console.log(`已发送 ${sess} 提醒（${text.length} 字符${chunks.length > 1 ? `，拆成 ${chunks.length} 条` : ''}）`);
}

export { signals, replay, pctRank, buildMessage, optionBlock, scanBlock, HIST, SAFE, gapTrigger, fetchMovers, scanHits, fetchDailyTD, pickOption, bs, realizedVol, OPT, etParts, session, isTradingDay,
         TICKERS, WIN, HI, LO, STOP };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
