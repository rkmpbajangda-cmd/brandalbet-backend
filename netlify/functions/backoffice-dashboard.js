import { protectedHandler } from '../../src/utils/protected-handler.js';
import { dashboard } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, env = process.env, run = dashboard } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET'], verifyIdToken, env, run: (actor, event) => run(actor, event, { env }) });
}
export const handler = createHandler();
