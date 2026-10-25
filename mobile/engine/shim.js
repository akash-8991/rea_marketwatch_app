/* Connects the unchanged web UI to the on-device engine: replaces window.fetch for same-origin /api/ requests.
 * Everything else (static files, other origins) goes through the original fetch. The session token lives in localStorage
 * (the WebView's private storage), where the desktop app uses an HttpOnly cookie. */
import { createEngine } from './engine.js';
import { IdbStorage } from './storage.js';

const TOKEN_KEY = 'ml.session';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
const writeToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage blocked */ } };

/** Optional overrides kept in localStorage 'ml.settings' (for example {"offline":true} to never contact NSE). */
const savedSettings = () => { try { return JSON.parse(localStorage.getItem('ml.settings')) || {}; } catch (e) { return {}; } };

export function installEngine(win = window, overrides = {}) {
  const realFetch = win.fetch.bind(win);
  const engine = createEngine({ storage: new IdbStorage(), fetchFn: realFetch, settings: savedSettings(), ...overrides });
  win.MLEngine = engine;
  win.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!/^\/api\//.test(url) && !/^\/(healthz)$/.test(url)) return realFetch(input, init);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res = await engine.handle((init.method || 'GET').toUpperCase(), url, { token: readToken(), headers, body: init.body || '' });
    if ('setToken' in res) writeToken(res.setToken);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };
  return engine;
}
