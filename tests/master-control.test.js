import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createMasterHandler } from '../netlify/functions/backoffice-master-control.js';
import { createHandler as createLaunchHandler } from '../netlify/functions/game-launch.js';
import { publicMasterControl } from '../src/backoffice/master-control.js';

const admin = { uid: 'admin-1', role: 'admin', backoffice: true };
const member = { uid: 'member-1', role: 'member', backoffice: false };
const backofficeEvent = { httpMethod: 'GET', headers: { Authorization: 'Bearer test' }, queryStringParameters: {} };

test('backoffice master control returns server-side state', async () => {
  const handler = createMasterHandler({
    verifyIdToken: async () => admin,
    load: async () => ({ maintenanceMode: false, gameLaunchEnabled: true, revision: 3 }),
  });
  const result = await handler(backofficeEvent);
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.control.revision, 3);
  assert.equal(body.control.gameLaunchEnabled, true);
});

test('public master control never exposes admin metadata', () => {
  const view = publicMasterControl({
    maintenanceMode: true,
    gameLaunchEnabled: false,
    registrationEnabled: true,
    promotionsEnabled: true,
    memberWalletEnabled: true,
    maintenanceMessage: 'Maintenance',
    revision: 9,
    updatedBy: 'secret-admin-uid',
  });
  assert.equal(view.maintenanceMode, true);
  assert.equal(view.gameLaunchEnabled, false);
  assert.equal('updatedBy' in view, false);
});

test('game launch is blocked by master maintenance mode before provider call', async () => {
  let launched = false;
  const handler = createLaunchHandler({
    verifyIdToken: async () => member,
    env: { MEMBER_SINGLE_SESSION_ENABLED: 'false' },
    loadControl: async () => ({ maintenanceMode: true, gameLaunchEnabled: true }),
    clientFactory: () => ({}),
    launch: async () => { launched = true; return {}; },
  });
  const result = await handler({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 1, gameSymbol: 'g1' }),
    queryStringParameters: {},
  });
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).error, 'maintenance_mode');
  assert.equal(launched, false);
});

test('game launch is blocked when master game launch switch is off', async () => {
  let launched = false;
  const handler = createLaunchHandler({
    verifyIdToken: async () => member,
    env: { MEMBER_SINGLE_SESSION_ENABLED: 'false' },
    loadControl: async () => ({ maintenanceMode: false, gameLaunchEnabled: false }),
    clientFactory: () => ({}),
    launch: async () => { launched = true; return {}; },
  });
  const result = await handler({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 1, gameSymbol: 'g1' }),
    queryStringParameters: {},
  });
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).error, 'game_launch_disabled');
  assert.equal(launched, false);
});
