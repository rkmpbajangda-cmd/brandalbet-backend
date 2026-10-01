import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import { postLedgerEntry } from '../src/ledger/service.js';
import { walletView } from '../src/wallet/service.js';
import { getOrCreateProfile } from '../src/member/profile.js';
const wallet = { uid: 'u1', currency: 'IDR', balanceMinor: 1000, availableMinor: 800, status: 'active' };
const posting = { uid: 'u1', amountMinor: 200, type: 'debit', source: 'test-provider', operationId: 'external-001' };

test('ledger replay is atomic and cannot double debit', async () => {
  const db = transactionDb({ 'wallets/u1': wallet });
  const results = await Promise.all(Array.from({length: 20}, () => postLedgerEntry(posting, { db })));
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal(db.read('wallets/u1').balanceMinor, 800);
  assert.equal(db.read('wallets/u1').availableMinor, 600);
  assert.equal(db.entries().filter(([k]) => k.startsWith('ledger/')).length, 1);
});
test('same upstream transaction cannot credit another UID or a changed amount', async () => {
  const db = transactionDb({ 'wallets/u1': wallet });
  await postLedgerEntry(posting, { db });
  for (const changed of [{ amountMinor: 201 }, { uid: 'u2' }, { type: 'credit' }]) {
    await assert.rejects(postLedgerEntry({ ...posting, ...changed }, { db }), { code: 'idempotency_conflict' });
  }
  assert.equal(db.read('wallets/u1').balanceMinor, 800);
});
test('simultaneous different debits cannot spend reserved balance', async () => {
  const db = transactionDb({ 'wallets/u1': wallet });
  const results = await Promise.allSettled([1,2].map(n => postLedgerEntry({ ...posting, amountMinor: 500, operationId: 'external-00' + n }, { db })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(db.read('wallets/u1').balanceMinor, 500);
  assert.equal(db.read('wallets/u1').availableMinor, 300);
});
test('ledger storage failure leaves neither wallet change nor entry', async () => {
  const db = transactionDb({ 'wallets/u1': wallet }); db.failCommit = true;
  await assert.rejects(postLedgerEntry(posting, { db }), /commit_failure/);
  assert.deepEqual(db.read('wallets/u1'), wallet);
  assert.equal(db.entries().length, 1);
});
test('wallet corruption, locks and overflow fail closed', async () => {
  for (const bad of [{ balanceMinor: -1 }, { availableMinor: 1001 }, { status: 'unknown' }, { currency: 'USD' }, { uid: 'u2' }]) {
    assert.throws(() => walletView('u1', { ...wallet, ...bad }), { code: 'wallet_integrity_error' });
  }
  const db = transactionDb({ 'wallets/u1': { ...wallet, status: 'locked' } });
  await assert.rejects(postLedgerEntry(posting, { db }), { code: 'wallet_locked' });
  const full = transactionDb({ 'wallets/u1': { ...wallet, balanceMinor: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(postLedgerEntry({ ...posting, type: 'credit' }, { db: full }), { code: 'amount_overflow' });
});
test('concurrent first profile requests all return the same profile', async () => {
  const db = transactionDb();
  const results = await Promise.all(Array.from({length: 5}, () => getOrCreateProfile({ uid: 'u1' }, { db })));
  assert.equal(db.entries().length, 1);
  assert.ok(results.every(r => r.uid === 'u1'));
});
