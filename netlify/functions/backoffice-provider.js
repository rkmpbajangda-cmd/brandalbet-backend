import { protectedHandler } from '../../src/utils/protected-handler.js';
import { providerStatus } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, env = process.env, run = providerStatus } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['GET', 'POST'], verifyIdToken, env, run: (actor, event) => run(actor, event, { env }) });
}
export const handler = createHandler();
