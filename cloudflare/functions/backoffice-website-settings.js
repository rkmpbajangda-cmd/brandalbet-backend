import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { websiteSettings } from '../../src/backoffice/website-assets.js';
import { getAdminDb } from '../../src/firebase/admin.js';

export function createHandler({ verifyIdToken, env = process.env, run = websiteSettings } = {}) {
  return protectedHandler({
    scope: 'backoffice',
    methods: ['GET', 'POST'],
    verifyIdToken,
    env,
    run: (actor, event) => run(
      actor,
      event,
      event.httpMethod === 'POST' ? parseJsonBody(event, 32768) : null,
      { db: getAdminDb(env) },
    ),
  });
}

export const handler = createHandler();
