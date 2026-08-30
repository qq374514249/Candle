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

// ── 取数：Yahoo Finance ───────────────────────────────────────────
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 两个 Yahoo 域名各试两轮，失败退避重试（偶发 403/429 很常见） */
async function yahoo(path) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    try {
      const res = await fetch(`https://${host}${path}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) { last = e; }
    await sleep(400 * (attempt + 1));
  }
  throw last;
}

// ── 取数：Yahoo Finance 日线 ──────────────────────────────────────
async function fetchDaily(ticker, range = '2y') {
  const j = await yahoo(`/v8/finance/chart/${ticker}`
                      + `?range=${range}&interval=1d&includePrePost=false`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`${ticker}: 无数据 ${j?.chart?.error?.description ?? ''}`);
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if ([o, h, l, c].some((v) => v == null || !isFinite(v))) continue;
    out.push({
      t: r.timestamp[i], o, h, l, c,
      d: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
           .format(new Date(r.timestamp[i] * 1000)),
    });
  }
  return out;
}

/** 盘中实时报价（用于止损监控） */
async function fetchQuote(ticker) {
  let j;
  try { j = await yahoo(`/v8/finance/chart/${ticker}?range=1d&interval=1m`); }
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
function buildMessage(sess, et, states, quotes = {}, errs = []) {
  const alive = TICKERS.filter((t) => states[t]);
  const held  = alive.filter((t) => states[t].pos !== 0);
  const acts  = alive.map((t) => actionLine(t, states[t])).filter(Boolean);

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
    L.push(acts.length ? acts.join('\n') : '\u3000\u65e0 \u2014\u2014 \u5f00\u76d8\u4e0d\u52a8\u3002');
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>\u3000<i>(\u6309\u6700\u65b0\u6536\u76d8\u4ef7)</i>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t], quotes[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...triggers(nxtCN + ' '));
    L.push('', '<u>\u6700\u65b0\u4fe1\u53f7\u8bfb\u6570</u>\u3000<i>(\u5206\u4f4d \u22650.80 \u6216 \u22640.20 \u624d\u89e6\u53d1)</i>');
    L.push(readout());

  } else if (sess === 'PRE') {
    L.push('<u>\u4eca\u5929\u5f00\u76d8\u8981\u505a\u7684\u4e8b</u>');
    L.push(acts.length ? acts.join('\n') : '\u3000\u65e0 \u2014\u2014 \u4eca\u5929\u5f00\u76d8\u4e0d\u52a8\u3002');
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...triggers('\u4eca\u5929'));

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
    L.push(acts.length ? acts.join('\n') : '\u3000\u65e0 \u2014\u2014 \u660e\u5929\u5f00\u76d8\u4e0d\u52a8\u3002');
    L.push('', '<u>\u4eca\u65e5\u4fe1\u53f7\u8bfb\u6570</u>\u3000<i>(\u5206\u4f4d \u22650.80 \u6216 \u22640.20 \u624d\u89e6\u53d1)</i>');
    L.push(readout());
    L.push('', '<u>\u5f53\u524d\u6301\u4ed3</u>');
    L.push(held.length ? held.map((t) => holdLine(t, states[t])).join('\n') : '\u3000\u5168\u90e8\u7a7a\u4ed3\u3002');
    L.push(...triggers('\u660e\u5929'));
    if (stale.length) L.push('', `<i>\u26a0\ufe0f ${stale.join('/')} \u7684\u4eca\u65e5K\u7ebf\u5c1a\u672a\u66f4\u65b0\uff0c\u8bfb\u6570\u53ef\u80fd\u662f\u4e0a\u4e00\u4ea4\u6613\u65e5\u7684\u3002</i>`);
  }

  if (errs.length) L.push('', `<i>\u26a0\ufe0f \u53d6\u6570\u5931\u8d25\uff1a${esc(errs.join('; '))}</i>`);
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

  const states = {}, errs = [];
  await Promise.all(TICKERS.map(async (t) => {
    try {
      const bars = await fetchDaily(t);
      if (bars.length < WIN + 5) throw new Error('\u5386\u53f2\u6570\u636e\u4e0d\u8db3');
      const sig = signals(bars);
      const st = replay(bars, sig);
      st.last = bars[bars.length - 1];
      st.lastSig = sig[sig.length - 1];
      st.gap = gapTrigger(bars);
      states[t] = st;
    } catch (e) { errs.push(`${t}: ${e.message}`); }
  }));
  if (!Object.keys(states).length) throw new Error(`\u5168\u90e8\u53d6\u6570\u5931\u8d25: ${errs.join('; ')}`);

  const quotes = {};
  const holding = TICKERS.filter((t) => states[t] && states[t].pos !== 0);
  if (sess === 'MID') {
    await Promise.all(holding.map(async (t) => { quotes[t] = await fetchQuote(t); }));
  } else if (sess === 'CLOSED') {
    // 休市没有实时价，用最近一个交易日的收盘价来算浮盈亏
    for (const t of holding) {
      const b = states[t].last;
      quotes[t] = { price: b.c, dayLow: b.l, dayHigh: b.h, prevClose: b.c };
    }
  }

  const { text, silent } = buildMessage(sess, et, states, quotes, errs);
  if (silent && !forced) { console.log('\u76d8\u4e2d\u65e0\u5f02\u5e38\uff0c\u9759\u9ed8'); return; }
  if (DRY_RUN || !TG_TOKEN || !TG_CHAT) { console.log(text.replace(/<[^>]+>/g, '')); return; }

  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const jr = await r.json();
  if (!jr.ok) { console.error('Telegram \u53d1\u9001\u5931\u8d25:', JSON.stringify(jr)); process.exit(1); }
  console.log(`\u5df2\u53d1\u9001 ${sess} \u63d0\u9192\uff08${text.length} \u5b57\u7b26\uff09`);
}

export { signals, replay, pctRank, buildMessage, gapTrigger, etParts, session, isTradingDay,
         TICKERS, WIN, HI, LO, STOP };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
