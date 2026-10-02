import { parseJsonBody } from '../../src/utils/body.js';
import { protectedHandler } from '../../src/utils/protected-handler.js';
import { report } from '../../src/backoffice/service.js';
export function createHandler({ verifyIdToken, run = report } = {}) {
  return protectedHandler({ scope: 'backoffice', methods: ['POST'], verifyIdToken, run: (actor, event) => run(actor, parseJsonBody(event, 4096)) });
}
export const handler = createHandler();
