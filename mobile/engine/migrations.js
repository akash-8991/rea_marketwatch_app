/* Saved-data format versioning, so an app update can never strand or damage accounts, saved snapshots or the audit log.
 *
 * Rules every release follows:
 *   1. The data format has a version number (`schema`). Every release up to and including Android 0.5.0 wrote version 1, with or
 *      without the stamp (the stamp is added on first start of a newer release).
 *   2. A release that changes the format adds a migration here (key = the version it produces). Nothing else may change stored data.
 *   3. Before a step runs, the affected data is copied to `backup:v<from>:<key>`. If a step throws, everything is rolled back to exactly
 *      what was there, the version stamp is not moved, and the app reports the problem instead of running on half-converted data.
 *   4. Data written by a NEWER format than this build understands is never touched (the app refuses to run on it).
 * Same application id, same signing key and same web origin (see mobile/tests/identity.test.mjs) are what let Android keep the data
 * across an update in the first place; this file covers the rest. */

export const CURRENT_SCHEMA = 1;
export const MIGRATIONS = {};   // e.g. 2: async (storage) => { ...rewrite stored values... }

const KEYS_TO_BACK_UP = ['users', 'users-seq', 'sessions', 'throttle', 'audit', 'snap-index'];

export class DataTooNew extends Error {}

export async function migrate(storage, { current = CURRENT_SCHEMA, migrations = MIGRATIONS } = {}) {
  let v = (await storage.get('schema')) ?? 1;
  if (v > current) throw new DataTooNew(`saved data is from a newer version of MarketLens (format ${v}); this build understands up to ${current}`);
  for (let next = v + 1; next <= current; next++) {
    const step = migrations[next];
    if (!step) throw new Error(`no migration to data format ${next}`);
    const original = {};
    for (const k of KEYS_TO_BACK_UP) { original[k] = await storage.get(k); if (original[k] !== null) await storage.set(`backup:v${v}:${k}`, original[k]); }
    try { await step(storage); } catch (e) {
      for (const k of KEYS_TO_BACK_UP) { if (original[k] === null) await storage.del(k); else await storage.set(k, original[k]); }   // roll back to exactly what was there
      throw e;
    }
    await storage.set('schema', next);
    v = next;
  }
  if ((await storage.get('schema')) !== v) await storage.set('schema', v);   // stamp unstamped (pre-0.5.1) data
  return v;
}
