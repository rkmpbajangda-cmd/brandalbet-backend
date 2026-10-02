import { protectedHandler } from '../../src/utils/protected-handler.js';
import { configurationReadiness } from '../../src/config/readiness.js';
import { ServiceError } from '../../src/utils/errors.js';
export function createHandler({ verifyIdToken, env = process.env } = {}) {
  return protectedHandler({ scope: 'backoffice', verifyIdToken, env, run: async actor => {
    if (!['admin', 'superadmin'].includes(actor.role)) throw new ServiceError('forbidden', 403);
    return { readiness: configurationReadiness(env) };
  } });
}
export const handler = createHandler();
