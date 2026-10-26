// "Update the app, keep your user ID, password and sign-in": what must stay true across releases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../engine/engine.js';
import { MemoryStorage } from '../engine/storage.js';
import { migrate, CURRENT_SCHEMA, DataTooNew } from '../engine/migrations.js';

const H = { 'x-requested-with': 'MarketLens' };
const ACCT = { name: 'Asha Rao', email: 'asha@example.com', dob: '1990-04-02', userId: 'asha.rao', password: 'tulip-orbit-77x' };
const NOFILE = { fetchLatest: async () => null };
const engine = (storage, settings = {}) => createEngine({ now: () => Date.parse('2026-10-24T12:00:00Z'), storage, optionSource: NOFILE, fetchFn: async () => new Response('', { status: 500 }), settings: { pbkdf2Iterations: 1000, refreshList: false, nseDelayMs: 0, ...settings } });
const post = (e, p, body, token) => e.handle('POST', p, { token, headers: H, body: JSON.stringify(body) });
const get = (e, p, token) => e.handle('GET', p, { token });

async function oldRelease() {                        // what a previous release left on the phone
  const storage = new MemoryStorage(), e = engine(storage);
  const token = (await post(e, '/api/auth/signup', ACCT)).setToken;
  await e.opts.importCsv(['OI,CHNG IN OI,VOLUME,IV,LTP,CHNG,BID,ASK,STRIKE,BID,ASK,CHNG,LTP,IV,VOLUME,CHNG IN OI,OI', '1,1,1,1,1,1,1,1,100,1,1,1,1,1,1,1,1', '1,1,1,1,1,1,1,1,200,1,1,1,1,1,1,1,1', '1,1,1,1,1,1,1,1,300,1,1,1,1,1,1,1,1'].join('\n'), 'asha.rao', 'option-chain-ED-NIFTY-27-Oct-2026.csv');
  await get(e, '/api/auth/me', token);               // make sure everything has been written
  return { storage, token };
}

test('after an update the same user ID and password sign in, and the session survives (still signed in)', async () => {
  const { storage, token } = await oldRelease();
  const updated = engine(storage);                   // new release, same storage
  assert.equal((await get(updated, '/api/auth/me', token)).body.user.userId, 'asha.rao');         // no new sign-in needed
  assert.deepEqual((await get(updated, '/api/auth/status', token)).body, { loginRequired: true, usersExist: true, signedIn: true });
  const again = await post(updated, '/api/auth/login', { userId: 'asha.rao', password: ACCT.password });
  assert.equal(again.status, 200);
  assert.equal((await post(updated, '/api/auth/login', { userId: 'asha.rao', password: 'wrong-wrong-wrong' })).status, 401);
  assert.equal((await post(updated, '/api/auth/forgot-user-id', { name: ACCT.name, email: ACCT.email, dob: ACCT.dob })).body.userId, 'asha.rao');
  assert.equal((await get(updated, '/api/options?symbol=NIFTY', token)).body.available, true);    // saved data too
  const log = (await get(updated, '/api/audit', token)).body;
  assert.equal(log.verify.ok, true);                                                              // audit chain still verifies
});

test('data saved by releases that never wrote a version stamp is read as format 1 and then stamped', async () => {
  const { storage } = await oldRelease();
  await storage.del('schema');                       // exactly what 0.5.0 and earlier left behind
  assert.equal(await migrate(storage), CURRENT_SCHEMA);
  assert.equal(await storage.get('schema'), CURRENT_SCHEMA);
  assert.equal((await storage.get('users')).length, 1);
});

test('a format change is applied with a backup first, and accounts still work afterwards', async () => {
  const { storage } = await oldRelease();
  const migrations = { 2: async (s) => { const users = await s.get('users'); users.forEach((u) => { u.migrated = true; }); await s.set('users', users); } };
  const updated = engine(storage, { migrations, schemaVersion: 2 });
  assert.equal((await post(updated, '/api/auth/login', { userId: 'asha.rao', password: ACCT.password })).status, 200);
  assert.equal(await storage.get('schema'), 2);
  assert.equal((await storage.get('users'))[0].migrated, true);
  assert.equal((await storage.get('backup:v1:users'))[0].migrated, undefined, 'the pre-migration copy is untouched');
  assert.ok(await storage.get('backup:v1:audit'));
});

test('a migration that fails is rolled back completely and reported, and a fixed release then upgrades the same data', async () => {
  const { storage } = await oldRelease();
  const before = JSON.stringify(await storage.get('users'));
  const broken = engine(storage, { migrations: { 2: async (s) => { await s.set('users', []); throw new Error('bug in migration'); } }, schemaVersion: 2 });
  const r = await get(broken, '/api/auth/status');
  assert.equal(r.status, 500); assert.match(r.body.error, /saved data was not changed|bug in migration/);
  assert.equal(await storage.get('schema') ?? 1, 1);
  assert.equal(JSON.stringify(await storage.get('users')), before, 'rolled back even though the step had already emptied the list');
  // and a fixed release then upgrades the very same data
  const fixed = engine(storage, { migrations: { 2: async (s) => { const u = await s.get('users'); u[0].v2 = true; await s.set('users', u); } }, schemaVersion: 2 });
  assert.equal((await post(fixed, '/api/auth/login', { userId: 'asha.rao', password: ACCT.password })).status, 200);
  assert.equal(await storage.get('schema'), 2);
});

test('data from a newer format is never touched by an older build', async () => {
  const storage = new MemoryStorage();
  await storage.set('schema', 9); await storage.set('users', [{ id: 1 }]);
  await assert.rejects(() => migrate(storage), DataTooNew);
  assert.equal(await storage.get('schema'), 9); assert.deepEqual(await storage.get('users'), [{ id: 1 }]);
  const e = engine(storage, { schemaVersion: 1 });
  assert.equal((await get(e, '/api/auth/status')).status, 500);
  assert.deepEqual(await storage.get('users'), [{ id: 1 }]);
});

test('what makes Android keep app data on update is pinned: application id, web origin, database name', () => {
  const cap = JSON.parse(readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(cap.appId, 'io.github.akash8991.marketlens', 'changing the application id installs a different app with empty data');
  assert.equal(cap.server.androidScheme, 'https', 'changing the scheme changes the web origin, and with it the stored data');
  assert.ok(!cap.server.hostname || cap.server.hostname === 'localhost');
  const storageSrc = readFileSync(new URL('../engine/storage.js', import.meta.url), 'utf8');
  assert.match(storageSrc, /constructor\(name = 'marketlens'\)/, 'the IndexedDB name must not change');
  assert.match(storageSrc, /indexedDB\.open\(this\.name, 1\)/, 'raising the IndexedDB version needs an onupgradeneeded migration');
  const wf = readFileSync(new URL('../../.github/workflows/android.yml', import.meta.url), 'utf8');
  assert.match(wf, /MARKETLENS_DEBUG_KEYSTORE/, 'builds must be signed with the stable key, or Android refuses the update');
  assert.match(wf, /--version-code "\$\{\{ github\.run_number \}\}"/, 'version code must keep rising');
});
