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
const QUIET_INTRADAY = (process.env.QUIET_INTRADAY ?? '1') !== '0';  // 盘中无事则不发
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

// 每条 cron 明确对应一个时段（GitHub 会把触发它的 cron 表达式传进来），
// 不再靠时钟去猜是哪一条 —— 避免夏令时/冬令时下两条 cron 撞进同一个时段。
const CRON_SESSION = {
  '45 12,13 * * 1-5': 'PRE',
  '0 14-20 * * 1-5':  'MID',
  '30 20,21 * * 1-5': 'POST',
  '30 14,15 * * *':   'CLOSED',
};
// 各时段允许发消息的美东时间窗口（分钟）
const WINDOW = {
  PRE:    [8 * 60,        9 * 60 + 30],    // 08:00–09:29
  MID:    [9 * 60 + 45,  15 * 60 + 55],    // 09:45–15:55（盘中每小时查一次）
  POST:   [16 * 60 + 5,  17 * 60],         // 16:05–16:59
  CLOSED: [10 * 60,      11 * 60 + 30],    // 10:00–11:29，仅休市日
};

/** 给定这次是哪条 cron 触发的，判断现在该不该发、发哪个时段 */
function sessionOf(et, intended) {
  const m = et.hour * 60 + et.minute;
  const trading = isTradingDay(et);
  if (intended === 'CLOSED') {
    return (!trading && m >= WINDOW.CLOSED[0] && m < WINDOW.CLOSED[1]) ? 'CLOSED' : null;
  }
  if (!trading) return null;                      // 交易日的三条 cron 在假日自动跳过
  const w = WINDOW[intended];
  return (w && m >= w[0] && m < w[1]) ? intended : null;
}

/** 手动触发（没有 cron 表达式）时，按时钟猜一个时段 */
function guessSession(et) {
  const m = et.hour * 60 + et.minute;
  if (!isTradingDay(et))
    return (m >= WINDOW.CLOSED[0] && m < WINDOW.CLOSED[1]) ? 'CLOSED' : null;
  for (const k of ['PRE', 'MID', 'POST'])
    if (m >= WINDOW[k][0] && m < WINDOW[k][1]) return k;
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
/** 先拿 Yahoo 的 cookie + crumb —— 榜单接口强制要 crumb，行情接口也更不容易被限流 */
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
    out.push({ t: r.timestamp[i], o, h, l, c, v: q.volume?.[i] ?? 0,
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
        o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume || 0,
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
  sessions: (process.env.SCAN_SESSIONS || 'PRE,CLOSED').split(',').map((x) => x.trim()),
  top:       Number(process.env.SCAN_TOP       || 10),    // 按成交额取前几名
  minPrice:  Number(process.env.SCAN_MIN_PRICE || 10),    // 股价门槛（宽松）
  minDolVol: Number(process.env.SCAN_MIN_DOLVOL|| 0),     // 成交额门槛，0=不限
  pool:      Number(process.env.SCAN_POOL      || 50),    // 从榜单前多少名里筛
};
// 回测里这套规则成立的区间：日成交额 ≥$2B 且 股价 ≥$50 的 10 只全部盈利，
// 低于这个区间的 6 只全部亏损。切点是看了结果画的（n=16），只当参考不当定律。
const SAFE = { dolVol: 2e9, price: 50 };

// Yahoo 榜单挂了时的备用名单：常见高流动性美股（固定 8 只以外），
// 会用各自的日线自行算成交额再排序，不依赖任何榜单接口。
const FALLBACK_UNIVERSE = (process.env.SCAN_FALLBACK
  || 'INTC,MU,AVGO,PLTR,COIN,SMCI,MRVL,QCOM,TXN,CRM,NFLX,ORCL,UBER,BAC,JPM,XOM,DIS,BA,SHOP,ARM')
  .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Yahoo 成交最活跃榜，然后按「成交额」重排（原榜是按股数，会全是低价股） */
async function fetchMovers() {
  // 只有这一个请求，值得多等一会儿：4 次尝试、退避到 20 秒
  const j = await yahoo('/v1/finance/screener/predefined/saved'
                      + `?scrIds=most_actives&count=${SCAN.pool}&formatted=false`, 4, 3500);
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

/** 近 20 根日线的平均成交额，用于备用名单自己排序 */
function avgDollarVol(bars, n = 20) {
  const t = bars.slice(-n);
  const v = t.filter((b) => b.v > 0);
  return v.length ? v.reduce((a, b) => a + b.c * b.v, 0) / v.length : 0;
}

/** 对每只候选股算 G3 买入信号，返回今天有信号的 */
async function scanHits(movers, fetchFn, gap) {
  const hits = [], failed = [];
  for (const m of movers) {
    try {
      const bars = await fetchFn(m.sym);
      if (bars.length < WIN + 5) { failed.push(`${m.sym}(数据不足)`); continue; }
      const sig = signals(bars);
      const last = sig[sig.length - 1];
      const lastBar = bars[bars.length - 1];
      // 榜单给了成交额就用榜单的；备用名单没有，就用日线自己算
      const px = lastBar.c;              // 跟信号、入场估算用同一个价，避免两处数字打架
      const dv = m.dv ?? avgDollarVol(bars);
      // 备用名单没经过榜单那一层过滤，这里补上同样的门槛
      if (px < SCAN.minPrice || dv < SCAN.minDolVol) continue;
      if (last.buy !== 0) {
        hits.push({ sym: m.sym, px, dv, dir: last.buy, xr: last.xr, bars,
                    rv: realizedVol(bars), gap: gapTrigger(bars), lastBar,
                    safe: dv >= SAFE.dolVol && px >= SAFE.price });
      }
    } catch (e) { failed.push(`${m.sym}(${String(e.message).slice(0, 30)})`); }
    await sleep(jitter(gap));
  }
  hits.sort((a, b) => b.dv - a.dv);
  return { hits, failed };
}

// ── 回测参考数字（用来在入场提示里给出历史预期）──────────────────
// 来自 2024-08~2026-08、8 只科技股、G3→G8 组合的 475 笔交易
const HIST = {
  avg: 0.0086, med: 0.0008, win: 0.0498, loss: -0.0347, wr: 0.512,
  holdMed: 3, holdP90: 11,          // 持仓交易日：中位 3，90% 在 11 天内结束
};


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
/** 近 n 日年化实际波动率，扫描结果里用来看这只股票有多躁 */
function realizedVol(bars, n = 60) {
  const r = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++)
    r.push(Math.log(bars[i].c / bars[i - 1].c));
  if (r.length < 20) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return sd * Math.sqrt(252);
}

const START = (process.env.START_DATE || '').trim();   // 例 '2026-08-31'，留空=按两年历史完整重放

/**
 * 重放持仓。指标仍用全部历史算（60日分位需要），
 * 但设了 START_DATE 之后，只允许「执行日 >= START_DATE」的开仓单成立 ——
 * 在第 i 根发出的开仓单是在第 i+1 根的开盘执行的，所以判断的是下一根的日期。
 */
function replay(bars, sig) {
  let pos = 0, ep = 0, epDate = null, pend = 0, trades = 0, wins = 0, eq = 1;
  const log = [];                       // 每笔平掉的交易，用来算上线以来的战绩
  const cost = 0.0005;
  const close = (px, date, why) => {
    const r = (pos === 1 ? px / ep - 1 : 1 - px / ep) - 2 * cost;
    eq *= 1 + r; trades++; if (r > 0) wins++;
    log.push({ dir: pos, inDate: epDate, inPx: ep, outDate: date, outPx: px, r, why });
    pos = 0; ep = 0; epDate = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // 1. 执行昨日挂单（今日开盘）
    if (pend !== 0 && pend !== -99 && pos === 0) { pos = pend; ep = b.o; epDate = b.d; pend = 0; }
    else if (pend === -99 && pos !== 0) { close(b.o, b.d, '信号'); pend = 0; }
    else pend = 0;
    // 2. 盘中止损
    if (pos !== 0) {
      const hit = pos === 1 ? b.l <= ep * (1 - STOP) : b.h >= ep * (1 + STOP);
      if (hit) { close(ep * (1 - STOP * pos), b.d, '止损'); continue; }
    }
    // 3. 生成明日挂单
    if (pos === 0) {
      const execDate = i + 1 < bars.length ? bars[i + 1].d : '9999-12-31';  // 最后一根 → 下一个开盘
      const allowed = !START || execDate >= START;
      if (allowed && sig[i].buy !== 0 && (ALLOW_SHORT || sig[i].buy === 1)) pend = sig[i].buy;
    } else if (sig[i].sell === -pos) pend = -99;
  }
  return { pos, ep, epDate, pend, trades, wins, eq, log };
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
  let pl = '';
  if (live?.price) {
    const r = s.pos === 1 ? live.price / s.ep - 1 : 1 - live.price / s.ep;
    pl = ` · 现价 ${money(live.price)} <b>${pct(r)}</b>`;
  }
  // 平仓触发价直接并进持仓行，不再单列一段
  const g = s.gap;
  const trig = g ? ` · 平仓触发 开盘 ${s.pos === 1 ? '≤' : '≥'} <b>${money(s.pos === 1 ? g.down : g.up)}</b>` : '';
  return `${s.pos === 1 ? '📈' : '📉'} <b>${t}</b> ${dirCN(s.pos)} @ ${money(s.ep)}`
       + ` (${s.epDate.slice(5)}) · 止损 ${money(stopPx(s))}${trig}${pl}`;
}

// ── 主流程 ───────────────────────────────────────────────────────
/**
 * 入场信号附带的「离场位置」。这套策略没有固定止盈——离场由 G8 跳空信号决定，
 * 所以能给出的确定数字是两个：8% 止损价，和会触发平仓信号的开盘价。
 *
 * 时点关系：今天收盘发出开仓信号 → 明天开盘建仓；G8 用「明天开盘 vs 今天收盘」判断，
 * 所以下面那个触发价说的就是明天开盘那一下，触发则后天开盘平仓。
 */
const HIST_FOOT = `<i>入场价按最近收盘价估算，实际以开盘价成交；「平仓触发」指开盘价落到该位置就发出信号，`
  + `再下一个开盘执行。没有固定止盈 —— 赢单拖到跳空信号出现为止。`
  + `历史：中位持有 ${HIST.holdMed} 个交易日，赢单均值 ${(HIST.win * 100).toFixed(1)}%、`
  + `输单均值 ${(HIST.loss * 100).toFixed(1)}%、胜率 ${(HIST.wr * 100).toFixed(0)}%。</i>`;

function entryPlan(t, s, dir) {
  const ref = s.lastBar?.c ?? s.last?.c;            // 用最近收盘价估算，实际以开盘价为准
  if (!ref) return null;
  const long = dir === 1;
  const stop = ref * (long ? 1 - STOP : 1 + STOP);
  const g = s.gap;
  const trig = g ? `　平仓触发 开盘 ${long ? '≤' : '≥'} <b>${money(long ? g.down : g.up)}</b>` : '';
  return `　　入场 ≈ <b>${money(ref)}</b>　止损 <b>${money(stop)}</b>${trig}`;
}


/**
 * 上线以来的战绩。不需要记账文件 —— replay 是确定性的，
 * 从 START_DATE 起重放一遍就能还原出每一笔，断更、换机器都不会丢。
 */
function scoreBlock(states, alive) {
  if (!START) return [];
  const all = [];
  for (const t of alive) for (const x of states[t].log) all.push({ t, ...x });
  const open = alive.filter((t) => states[t].pos !== 0);
  if (!all.length && !open.length) return [];

  const L = ['', `<u>📒 上线战绩</u>　<i>(${START} 起 · 策略账面，按开盘价成交、含 0.05% 成本)</i>`];
  if (all.length) {
    all.sort((a, b) => (a.outDate < b.outDate ? 1 : -1));
    const wins = all.filter((x) => x.r > 0);
    const avg = all.reduce((a, b) => a + b.r, 0) / all.length;
    // 每只股票各自复利，再取平均 —— 跟回测同口径（等权分散在 8 只上），
    // 不是把所有交易连乘（那等于每笔都满仓压一只，不是真实拿法）
    const eqs = alive.map((t) => states[t].log.reduce((a, x) => a * (1 + x.r), 1));
    const eq = eqs.reduce((a, b) => a + b, 0) / eqs.length;
    // 同期买入持有对照
    const bhs = alive.map((t) => {
      const bars = states[t].bars ?? [];
      const from = bars.find((x) => x.d >= START);
      return from ? bars[bars.length - 1].c / from.o : null;
    }).filter((x) => x);
    const bh = bhs.length ? bhs.reduce((a, b) => a + b, 0) / bhs.length : null;
    const stops = all.filter((x) => x.why === '止损').length;

    L.push(`　已平仓 <b>${all.length}</b> 笔　胜率 <b>${(wins.length / all.length * 100).toFixed(0)}%</b>`
         + `　单笔均值 ${pct(avg)}${stops ? `　止损出场 ${stops} 次` : ''}`);
    L.push(`　策略净值 <b>${eq.toFixed(3)}x</b>　同期买入持有 <b>${bh ? bh.toFixed(3) + 'x' : '—'}</b>`
         + (bh ? `　<b>${eq > bh ? '跑赢' : '跑输'} ${pct(eq / bh - 1)}</b>` : '')
         + `　<i>(${alive.length} 只等权平均)</i>`);
    const best = all.reduce((a, b) => (b.r > a.r ? b : a));
    const worst = all.reduce((a, b) => (b.r < a.r ? b : a));
    L.push(`　最好 ${best.t} ${pct(best.r)}　最差 ${worst.t} ${pct(worst.r)}`);
    L.push('　<i>最近平仓：</i>');
    for (const x of all.slice(0, 4)) {
      L.push(`　<code>${x.t.padEnd(5)} ${x.dir === 1 ? '多' : '空'} `
           + `${x.inDate.slice(5)}→${x.outDate.slice(5)} `
           + `${money(x.inPx)}→${money(x.outPx)} ${pct(x.r).padStart(7)} ${x.why}</code>`);
    }
    if (all.length > 4) L.push(`　<i>…另有 ${all.length - 4} 笔</i>`);
  } else {
    L.push('　还没有平仓的交易。');
  }
  if (open.length) L.push(`　持仓中 ${open.length} 只：${open.join(' ')}`);
  return L;
}

function scanBlock(scan) {
  if (!scan) return [];
  const { hits, failed, n } = scan;
  const L = ['', scan.src === '备用名单'
    ? `<u>🔍 热股扫描</u>　<i>(⚠️ Yahoo 榜单取不到，改用 ${n} 只高流动性备用名单)</i>`
    : `<u>🔍 热股扫描</u>　<i>(成交额前 ${n} 名，固定名单以外)</i>`];
  if (!hits.length) {
    L.push('　无 —— 今天没扫到新机会。');
  } else {
    for (const h of hits) {
      const dir = h.dir === 1 ? '🟢 <b>做多</b>' : '🔴 <b>做空</b>';
      const zone = h.safe ? '' : '　<b>⚠️ 验证区外</b>';
      L.push(`${dir} <b>${h.sym}</b>　$${money(h.px)}`
           + `　成交额 $${(h.dv / 1e9).toFixed(1)}B`
           + `　影线分位 ${h.xr.toFixed(3)}`
           + (h.rv ? `　波动 ${(h.rv * 100).toFixed(0)}%` : '') + zone);
      const ep = entryPlan(h.sym, h, h.dir);
      if (ep) L.push(ep);
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
  return `　<i>没有触发新的开仓信号。${tip}</i>`;
}

function buildMessage(sess, et, states, quotes = {}, errs = [], scan = null) {
  const alive = TICKERS.filter((t) => states[t]);
  const held  = alive.filter((t) => states[t].pos !== 0);
  const hasEntry = alive.some((t) => states[t].pend === 1 || states[t].pend === -1)
                || (scan?.hits?.length > 0);
  const acts = alive.map((t) => {
    const line = actionLine(t, states[t]);
    if (!line) return null;
    const ep = states[t].pend === 1 || states[t].pend === -1
      ? entryPlan(t, states[t], states[t].pend) : null;
    return ep ? `${line}\n${ep}` : line;
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


  if (sess === 'CLOSED') {
    L.push(`<u>${nxtCN} \u5f00\u76d8\u8981\u505a\u7684\u4e8b</u>\u3000<i>(\u57fa\u4e8e\u6700\u8fd1\u4e00\u4e2a\u4ea4\u6613\u65e5\u7684\u6536\u76d8 K \u7ebf)</i>`);
    if (acts.length) L.push(acts.join('\n'));
    else { L.push('\u3000\u65e0 \u2014\u2014 \u5f00\u76d8\u4e0d\u52a8\u3002'); L.push(noActionNote(states, alive)); }
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>\u3000<i>(\u6309\u6700\u65b0\u6536\u76d8\u4ef7)</i>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t], quotes[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push('', '<u>\u6700\u65b0\u4fe1\u53f7\u8bfb\u6570</u>\u3000<i>(\u5206\u4f4d \u22650.80 \u6216 \u22640.20 \u624d\u89e6\u53d1)</i>');
    L.push(readout());
    L.push(...scoreBlock(states, alive));
    L.push(...scanBlock(scan));

  } else if (sess === 'PRE') {
    L.push('<u>\u4eca\u5929\u5f00\u76d8\u8981\u505a\u7684\u4e8b</u>');
    if (acts.length) L.push(acts.join('\n'));
    else { L.push('\u3000\u65e0 \u2014\u2014 \u4eca\u5929\u5f00\u76d8\u4e0d\u52a8\u3002'); L.push(noActionNote(states, alive)); }
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...scanBlock(scan));

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
    L.push(...scoreBlock(states, alive));
    L.push(...scanBlock(scan));
    if (stale.length) L.push('', `<i>\u26a0\ufe0f ${stale.join('/')} \u7684\u4eca\u65e5K\u7ebf\u5c1a\u672a\u66f4\u65b0\uff0c\u8bfb\u6570\u53ef\u80fd\u662f\u4e0a\u4e00\u4ea4\u6613\u65e5\u7684\u3002</i>`);
  }

  if (hasEntry) L.push('', HIST_FOOT);
  if (errs.length) {
    // 同一个原因的合并成一行，别把同一句话重复很多遍
    const groups = new Map();
    for (const e of errs) {
      const m = e.match(/^([A-Z.]{1,6})\s*(.*?)\((.*)\)$/s);
      const key = m ? `${m[2]}(${m[3]})` : e;
      if (!groups.has(key)) groups.set(key, []);
      if (m) groups.get(key).push(m[1]);
    }
    L.push('', '<i>⚠️ 取数失败</i>');
    for (const [reason, who] of groups) {
      L.push(who.length > 2 ? `　<i>${esc(who.length + ' 只' + reason)}</i>　<code>${esc(who.join(' '))}</code>`
                            : `　<i>${esc((who.length ? who.join('/') + ' ' : '') + reason)}</i>`);
    }
  }
  L.push('', '<i>\u5386\u53f2\u566a\u58f0\u5bf9\u7167\u663e\u793a\u8be5\u7ec4\u5408\u6709\u7ea6 15% \u6982\u7387\u662f\u968f\u673a\u4ea7\u7269\u3002\u8fd9\u662f\u76d1\u63a7\uff0c\u4e0d\u662f\u6295\u8d44\u5efa\u8bae\u3002</i>');
  return { text: L.join('\n'), silent, held, acts };
}

async function main() {
  const et = etParts();
  const forced = process.env.FORCE_SESSION;       // 手动触发时指定时段
  const sched = (process.env.SCHEDULE || '').trim();
  const sess = forced
    || (CRON_SESSION[sched] ? sessionOf(et, CRON_SESSION[sched]) : guessSession(et));

  if (!forced && !sess) {
    console.log(`美东 ${et.date} ${et.hhmm}（${isTradingDay(et) ? '交易日' : '休市'}）`
              + `${sched ? ` · cron「${sched}」→ ${CRON_SESSION[sched] ?? '未知'}` : ''}`
              + ` 不在提醒窗口，跳过`);
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
    st.bars = bars;                 // 战绩里要算同期买入持有
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

  // 热股扫描：榜单打不通就退到备用名单，不让整个扫描因为一个接口挂掉
  let scan = null;
  if (SCAN.on && SCAN.sessions.includes(sess)) {
    let movers = null, src = '热股榜';
    try {
      if (!CRUMB) await warmup();                 // 榜单接口要 crumb
      movers = await fetchMovers();
      console.log(`热股榜取到 ${movers.length} 只：${movers.map((m) => m.sym).join(' ')}`);
    } catch (e) {
      console.log(`热股榜取不到（${e.message}），改用备用名单`);
      src = '备用名单';
      movers = FALLBACK_UNIVERSE.filter((t) => !TICKERS.includes(t)).map((sym) => ({ sym }));
    }
    if (movers?.length) {
      const r = await scanHits(movers, working.short, working.gap);
      // 备用名单没有榜单排序，用各自算出来的成交额排完再取前 N
      const hits = src === '热股榜' ? r.hits : r.hits.slice(0, SCAN.top);
      scan = { hits, failed: r.failed, n: movers.length, src };
      console.log(`扫描(${src}, ${working.name}) 命中 ${hits.length} 只`
                + `${r.failed.length ? '，失败 ' + r.failed.length + ' 只' : ''}`);
    } else {
      errs.push('热股扫描(无候选)');
    }
  }

  const { text, silent } = buildMessage(sess, et, states, quotes, errs, scan);
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

export { signals, replay, pctRank, buildMessage, entryPlan, scanBlock, scoreBlock, HIST, SAFE, gapTrigger, fetchMovers, scanHits, fetchDailyTD, realizedVol, etParts, sessionOf, guessSession, CRON_SESSION, WINDOW, isTradingDay,
         TICKERS, WIN, HI, LO, STOP };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
