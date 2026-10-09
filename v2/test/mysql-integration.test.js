import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

test('MySQL integration: concurrent wallet debits cannot overspend and repeated references are idempotent', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const {pool} = await import('../src/db.js');
  const {creditWallet, debitWallet} = await import('../src/wallet.js');
  const userId = crypto.randomUUID();
  const suffix = userId.replaceAll('-', '');
  try {
    await pool.query(
      'INSERT INTO users(id,username,email,password_hash,role,status) VALUES(?,?,?,?,?,?)',
      [userId, 'it_' + suffix.slice(0, 24), 'it_' + suffix + '@example.test', 'test-only-hash', 'member', 'active']
    );
    await pool.query('INSERT INTO wallets(user_id,balance,locked_balance) VALUES(?,100,0)', [userId]);

    const spends = await Promise.allSettled([
      debitWallet(userId, 80, 'integration_spend', 'it-spend-a-' + userId),
      debitWallet(userId, 80, 'integration_spend', 'it-spend-b-' + userId)
    ]);
    assert.equal(spends.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(spends.filter(x => x.status === 'rejected').length, 1);
    assert.equal(spends.find(x => x.status === 'rejected').reason.code, 'insufficient_balance');

    const ref = 'it-credit-same-' + userId;
    const credits = await Promise.all([
      creditWallet(userId, 10, 'integration_credit', ref),
      creditWallet(userId, 10, 'integration_credit', ref)
    ]);
    assert.equal(credits.filter(x => x.idempotent === false).length, 1);
    assert.equal(credits.filter(x => x.idempotent === true).length, 1);
    await assert.rejects(
      creditWallet(userId, 11, 'integration_credit', ref),
      {code: 'idempotency_conflict'}
    );

    const [[wallet]] = await pool.query('SELECT balance FROM wallets WHERE user_id=?', [userId]);
    assert.equal(Number(wallet.balance), 30);
    const [[ledger]] = await pool.query('SELECT COUNT(*) AS count FROM wallet_ledger WHERE user_id=?', [userId]);
    assert.equal(Number(ledger.count), 2);
  } finally {
    await pool.query('DELETE FROM wallet_ledger WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM transactions WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM wallets WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id=?', [userId]).catch(() => {});
    await pool.end();
  }
});
