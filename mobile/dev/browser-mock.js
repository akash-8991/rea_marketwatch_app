/* Development helper (not part of the app): stands in for NSE's MCP servers inside a desktop browser, which cannot reach them (CORS), so the real UI can be
 * exercised end to end. Serve mobile/www, copy this file and the two seed JSON files from data-cache into mobile/www/_seed/, then in the page console run:
 *   (0,eval)(await (await fetch('/_seed/browser-mock.js')).text())
 * Prices are synthetic and deliberately simple; the shapes match the real MCP replies. */
(async () => {
  const E = window.MLEngine; E.nse.offline = false; E.cfg.offline = false;
  await E.snaps.put('bootstrap', await (await fetch('/_seed/bootstrap.json')).json()); await E.snaps.put('extras', await (await fetch('/_seed/extras.json')).json());
  window.__nseCalls = { quote: 0, history: 0, bulk: 0 };
  E.nse.fetchFn = async (url, init = {}) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'Mcp-Session-Id': 's' } });
    if (b.method === 'notifications/initialized') return new Response('', { status: 404 });
    const n = b.params.name, a = b.params.arguments; let out; const h = (s) => [...s].reduce((x, c) => x + c.charCodeAt(0), 0);
    if (n === 'cm_get_stock_quote') {
      window.__nseCalls.quote++; const k = h(a.symbol);
      if (a.symbol === 'NOPE') out = { stock: null };
      else { const price = +(1000 + k % 500).toFixed(2), ch = ((k % 900) / 100 - 4.2); out = { stock: { lastTradedPrice: price, preClosePrice: +(price / (1 + ch / 100)).toFixed(2), perChange: +ch.toFixed(2), volume: 100000 + k * 37, value: +(k / 3).toFixed(1), latestTimestamp: '2026-10-23 16:00:29', series: 'EQ', fiftyTwoWeekHigh: 1500, fiftyTwoWeekLow: 900, perChange30d: 2.1, openPrice: 1000, highPrice: 1010, lowPrice: 990 } }; }
    } else if (n === 'get_stock_history') {
      window.__nseCalls.history++; const k = h(a.symbol), end = a.endDate ? new Date(a.endDate + 'T00:00:00Z') : new Date(Date.UTC(2026, 9, 23)); const rows = [];
      for (let i = 0; i < 63; i++) { const d = new Date(end.getTime() - (62 - i) * 1.4 * 86400000); if (d < new Date(Date.UTC(2024, 0, 1))) continue; const t = (d - Date.UTC(2024, 0, 1)) / 86400000;
        rows.push({ date: d.toISOString().slice(0, 10), open: 1, high: 2, low: 1, close: +(1000 + t * 0.35 + Math.sin(t / 9 + k) * 60 + Math.sin(t / 3) * 14).toFixed(2), volume: 1000 + i }); }
      const first = rows[0] && rows[0].date; out = { data: rows, next_end_date: first && first > '2024-01-10' ? new Date(Date.parse(first) - 86400000).toISOString().slice(0, 10) : null };
    } else if (n === 'get_52_week_high_low') out = { '52w_high': 1500, '52w_low': 900, position_in_range_pct: 40 };
    else if (n === 'get_corporate_actions') out = { actions: [] };
    else if (n === 'get_bulk_quote') { window.__nseCalls.bulk++; out = { quotes: a.symbols.map((symbol, i) => ({ symbol, close: 100, volume: (a.symbols.length - i) * 1000 })) }; }
    else out = { date: '2026-10-23' };
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) + '\n\n');
  };
  window.__mockReady = true;
})();
