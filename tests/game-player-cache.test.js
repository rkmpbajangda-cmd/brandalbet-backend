import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureGoldslotPlayer, clearGoldslotPlayerCacheForTest } from '../src/game/player.js';
import { transactionDb } from './helpers/transaction-db.js';

const actor = { uid: 'member-cache-1' };

function existingDb(verifiedAt) {
  return transactionDb({
    'providerPlayers/member-cache-1': {
      uid: 'member-cache-1',
      provider: 'goldslotpalase',
      providerUsername: 'bb_cached',
      userCode: 77,
      verifiedAt,
    },
  });
}

test('recent provider player mapping avoids createUser round trip', async () => {
  clearGoldslotPlayerCacheForTest();
  const now = Date.parse('2026-10-03T02:00:00.000Z');
  const db = existingDb(new Date(now - 60_000));
  let createCalls = 0;
  const player = await ensureGoldslotPlayer(actor, {
    db,
    now: () => now,
    client: { createUser: async () => { createCalls++; return { user_code: 99 }; } },
  });
  assert.equal(player.userCode, 77);
  assert.equal(createCalls, 0);
});

test('warm in-memory player cache avoids repeated Firestore/provider work', async () => {
  clearGoldslotPlayerCacheForTest();
  const now = Date.parse('2026-10-03T02:00:00.000Z');
  const db = existingDb(new Date(now - 60_000));
  let createCalls = 0;
  const client = { createUser: async () => { createCalls++; return { user_code: 99 }; } };
  const first = await ensureGoldslotPlayer(actor, { db, now: () => now, client });
  const second = await ensureGoldslotPlayer(actor, { db: { collection: () => { throw new Error('should_not_read_db'); } }, now: () => now + 1_000, client });
  assert.equal(first.userCode, 77);
  assert.equal(second.userCode, 77);
  assert.equal(createCalls, 0);
});

test('provider player mapping stays reusable throughout the seven-day refresh window', async () => {
  clearGoldslotPlayerCacheForTest();
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  const db = existingDb(new Date(now - 6 * 24 * 60 * 60 * 1000));
  let createCalls = 0;
  const player = await ensureGoldslotPlayer(actor, {
    db,
    now: () => now,
    client: { createUser: async () => { createCalls++; return { user_code: 99 }; } },
  });
  assert.equal(player.userCode, 77);
  assert.equal(createCalls, 0);
});

test('provider player mapping older than seven days is revalidated once', async () => {
  clearGoldslotPlayerCacheForTest();
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  const db = existingDb(new Date(now - 8 * 24 * 60 * 60 * 1000));
  let createCalls = 0;
  const player = await ensureGoldslotPlayer(actor, {
    db,
    now: () => now,
    client: { createUser: async name => { createCalls++; assert.match(name, /^bb_[a-f0-9]{32}$/); return { user_code: 88 }; } },
  });
  assert.equal(player.userCode, 88);
  assert.equal(createCalls, 1);
  assert.equal(db.read('providerPlayers/member-cache-1').userCode, 88);
});
