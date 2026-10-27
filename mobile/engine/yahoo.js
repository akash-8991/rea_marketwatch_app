/* Intraday candles for the chart page (port of yahoo.py). NSE's servers keep daily history only, so 5-minute, 15-minute and hourly candles come from Yahoo Finance's
 * public chart endpoint (the provider the news headlines already use). Stocks are SYMBOL.NS; a set of NSE indices has a Yahoo ticker. Prices can lag the exchange by a
 * few minutes and the page says where the candles came from. Offline mode makes no request. */
export const FRAMES = { '5m': ['5m', '30d'], '15m': ['15m', '60d'], '1h': ['60m', '730d'] };
export const INDEX_TICKERS = {
  IDX_NIFTY_50: '^NSEI', IDX_NIFTY_BANK: '^NSEBANK', IDX_NIFTY_NEXT_50: '^NSMIDCP', IDX_NIFTY_100: '^CNX100', IDX_NIFTY_200: '^CNX200', IDX_NIFTY_500: '^CRSLDX',
  IDX_NIFTY_MIDCAP_50: '^NSEMDCP50', IDX_NIFTY_SMALLCAP_100: '^CNXSC', IDX_NIFTY_IT: '^CNXIT', IDX_NIFTY_AUTO: '^CNXAUTO', IDX_NIFTY_FMCG: '^CNXFMCG',
  IDX_NIFTY_METAL: '^CNXMETAL', IDX_NIFTY_PHARMA: '^CNXPHARMA', IDX_NIFTY_REALTY: '^CNXREALTY', IDX_NIFTY_ENERGY: '^CNXENERGY', IDX_NIFTY_PSU_BANK: '^CNXPSUBANK',
  IDX_NIFTY_MEDIA: '^CNXMEDIA', IDX_NIFTY_FIN_SERVICE: '^CNXFIN', IDX_NIFTY_INFRASTRUCTURE: '^CNXINFRA', IDX_NIFTY_PSE: '^CNXPSE', IDX_INDIA_VIX: '^INDIAVIX',
};
const SYMBOL = /^[A-Za-z0-9&_-]{1,24}$/;

export const ticker = (sym) => (sym.startsWith('IDX_') ? INDEX_TICKERS[sym] || null : SYMBOL.test(sym) ? `${sym}.NS` : null);

/** Candles [[epoch s, o, h, l, c, v], ...] from a Yahoo chart answer; rows with a missing price are dropped. */
export function parse(doc) {
  const res = ((doc.chart || {}).result || [])[0];
  if (!res) throw new Error(((doc.chart || {}).error || {}).description || 'no data for this symbol');
  const q = ((res.indicators || {}).quote || [{}])[0], out = [];
  (res.timestamp || []).forEach((t, i) => {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if ([o, h, l, c].some((x) => x == null)) return;
    out.push([t, +o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +c.toFixed(2), (q.volume && q.volume[i]) || 0]);
  });
  return out;
}

export async function fetchCandles({ fetchFn, sym, tf, offline = false, cache, ttl }) {
  const base = { sym, tf, candles: [] };
  if (!FRAMES[tf]) return { ...base, available: false, reason: 'unknown timeframe' };
  const tk = ticker(sym);
  if (!tk) return { ...base, available: false, reason: 'no intraday source for this index' };
  if (offline) return { ...base, available: false, reason: 'offline mode: no requests are made' };
  const [interval, range] = FRAMES[tf];
  try {
    const c = await cache.cached(`yc:${sym}:${tf}`, ttl, async () => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tk)}?interval=${interval}&range=${range}&includePrePost=false`;
      const r = await fetchFn(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parse(await r.json());
    });
    return { ...base, available: c.length > 0, candles: c, source: `Yahoo Finance (${tk}); can lag the exchange by a few minutes`, ...(c.length ? {} : { reason: 'no candles returned' }) };
  } catch (e) { return { ...base, available: false, reason: `Yahoo Finance did not answer: ${String(e.message || e).slice(0, 100)}` }; }
}
