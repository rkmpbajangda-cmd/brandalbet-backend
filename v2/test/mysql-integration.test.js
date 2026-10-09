import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

test('MySQL integration: concurrent wallet debits cannot overspend and repeated references are idempotent', {
  skip: !process.env.DATABASE_URL || !process.env.XENDIT_WEBHOOK_TOKEN
}, async () => {
  const {pool} = await import('../src/db.js');
  const {creditWallet, debitWallet} = await import('../src/wallet.js');
  const {handleXenditPaymentWebhook, handleXenditPayoutWebhook} = await import('../src/xendit-payment.js');
  const userId = crypto.randomUUID();
  const suffix = userId.replaceAll('-', '');
  const paymentId = 'it-pay-' + suffix;
  const paymentRequestId = 'it-pr-' + suffix;
  const depositReference = 'IT-DEP-' + suffix;
  const payoutId = 'it-payout-' + suffix;
  const withdrawalReference = 'IT-WD-' + suffix;
  const callbackRequest = body => ({body, get: name => name.toLowerCase() === 'x-callback-token' ? process.env.XENDIT_WEBHOOK_TOKEN : null});
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

    // Exercise the real MySQL transaction path for duplicate Xendit payment webhooks.
    await pool.query(
      'INSERT INTO payment_orders(id,user_id,reference,amount,channel,status,provider_reference) VALUES(?,?,?,?,?,?,?)',
      [crypto.randomUUID(), userId, depositReference, 50, 'QRIS', 'pending', paymentRequestId]
    );
    await pool.query(
      'INSERT INTO deposits(id,user_id,amount,status,gateway,gateway_reference,payment_request_id,metadata) VALUES(?,?,?,?,?,?,?,?)',
      [crypto.randomUUID(), userId, 50, 'pending', 'xendit', paymentRequestId, paymentRequestId, JSON.stringify({reference:depositReference})]
    );
    const paymentEvent = {event:'payment.capture',data:{payment_id:paymentId,payment_request_id:paymentRequestId,reference_id:depositReference,request_amount:50,status:'SUCCEEDED'}};
    const firstPayment = await handleXenditPaymentWebhook(callbackRequest(paymentEvent));
    const replayPayment = await handleXenditPaymentWebhook(callbackRequest(paymentEvent));
    assert.equal(firstPayment.processed, true);
    assert.equal(replayPayment.idempotent, true);
    let [[walletAfterDeposit]] = await pool.query('SELECT balance FROM wallets WHERE user_id=?', [userId]);
    assert.equal(Number(walletAfterDeposit.balance), 80);

    // Exercise payout settlement and webhook replay with reserved withdrawal funds.
    await pool.query('UPDATE wallets SET locked_balance=20 WHERE user_id=?', [userId]);
    await pool.query(
      'INSERT INTO withdrawals(id,user_id,amount,status,metadata) VALUES(?,?,?,?,?)',
      [crypto.randomUUID(), userId, 20, 'pending', JSON.stringify({reference:withdrawalReference})]
    );
    const payoutEvent = {event:'payout.succeeded',data:{payout_id:payoutId,reference_id:withdrawalReference,status:'SUCCEEDED',source_amount:20}};
    const firstPayout = await handleXenditPayoutWebhook(callbackRequest(payoutEvent));
    const replayPayout = await handleXenditPayoutWebhook(callbackRequest(payoutEvent));
    assert.equal(firstPayout.processed, true);
    assert.equal(replayPayout.idempotent, true);
    const [[walletAfterPayout]] = await pool.query('SELECT balance,locked_balance FROM wallets WHERE user_id=?', [userId]);
    assert.equal(Number(walletAfterPayout.balance), 60);
    assert.equal(Number(walletAfterPayout.locked_balance), 0);
  } finally {
    await pool.query('DELETE FROM webhook_events WHERE event_key IN (?,?)', ['xendit:payment.capture:' + paymentId, 'xendit_payout:payout.succeeded:' + payoutId]).catch(() => {});
    await pool.query('DELETE FROM wallet_ledger WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM transactions WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM payment_orders WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM deposits WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM withdrawals WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM wallets WHERE user_id=?', [userId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id=?', [userId]).catch(() => {});
    await pool.end();
  }
});
