import { randomUUID } from 'node:crypto';

function header(event, name) {
  const key = Object.keys(event?.headers ?? {}).find((item) => item.toLowerCase() === name);
  return key ? event.headers[key] : undefined;
}

export function auditSecurityEvent({ event, actor, action, outcome }) {
  const requestId =
    header(event, 'x-nf-request-id') ||
    header(event, 'x-request-id') ||
    randomUUID();

  const record = {
    type: 'security_audit',
    timestamp: new Date().toISOString(),
    requestId,
    uid: actor?.uid ?? null,
    role: actor?.role ?? null,
    action,
    outcome,
  };

  console.info(JSON.stringify(record));
  return requestId;
}
