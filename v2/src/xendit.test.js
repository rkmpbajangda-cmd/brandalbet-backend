import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCallbackToken,payoutTerminalStatus,createXendit} from './xendit.js';

test('Xendit callback token comparison is constant-time compatible',()=>{
 assert.equal(verifyCallbackToken('secret','secret'),true);
 assert.equal(verifyCallbackToken('bad','secret'),false);
 assert.equal(verifyCallbackToken('',''),false);
});

test('Xendit payout terminal statuses are recognized',()=>{
 for(const s of ['SUCCEEDED','FAILED','REVERSED','REJECTED','CANCELLED','EXPIRED'])assert.equal(payoutTerminalStatus(s),true);
 assert.equal(payoutTerminalStatus('ACCEPTED'),false);
});

test('Xendit adapter stays unconfigured without API key',()=>{
 const x=createXendit({apiKey:''});
 assert.equal(x.configured,false);
});
