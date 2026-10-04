import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { websiteSettings } from '../../src/backoffice/website-assets.js';

export function createHandler({ verifyIdToken, run = websiteSettings } = {}) {
  return protectedHandler({
    scope: 'backoffice',
    methods: ['GET', 'POST'],
    verifyIdToken,
    run: (actor, event) => run(
      actor,
      event,
      event.httpMethod === 'POST' ? parseJsonBody(event, 32768) : null,
    ),
  });
}

export const handler = createHandler();
