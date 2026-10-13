import { spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = 8787;
const baseUrl = `http://${host}:${port}`;
const origin = 'https://brandalbet.blogspot.com';
const child = spawn('npx', [
  '--yes',
  'wrangler@4.129.1',
  'dev',
  '--local',
  '--ip', host,
  '--port', String(port),
  '--log-level', 'error',
], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, CI: '1' },
});

let childExit;
child.once('exit', (code, signal) => {
  childExit = { code, signal };
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path) {
  return fetch(`${baseUrl}${path}`, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(3000),
  });
}

async function waitForServer() {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (childExit) throw new Error(`Wrangler exited before startup: ${JSON.stringify(childExit)}`);
    try {
      const response = await request('/health');
      if (response.status === 200) return;
      lastError = new Error(`/health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Cloudflare Worker local startup timed out: ${lastError?.message ?? 'no response'}`);
}

async function expectStatus(path, expectedStatus, expectedError) {
  const response = await request(path);
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected HTTP ${expectedStatus}, received HTTP ${response.status}; body=${body.slice(0, 500)}`);
  }
  if (expectedError) {
    let payload;
    try { payload = JSON.parse(body); } catch {
      throw new Error(`${path}: expected JSON response; body=${body.slice(0, 300)}`);
    }
    if (payload.error !== expectedError) {
      throw new Error(`${path}: expected error ${expectedError}, received ${String(payload.error)}`);
    }
  }
}

try {
  await waitForServer();
  await expectStatus('/api/health', 200);
  await expectStatus('/api/member-onboarding', 405, 'method_not_allowed');
  await expectStatus('/api/member-device-session', 405, 'method_not_allowed');
  console.log('Cloudflare runtime smoke test passed: Worker starts and health/onboarding/device-session routes initialize without handler-load failures.');
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  if (!childExit) child.kill('SIGKILL');
}
