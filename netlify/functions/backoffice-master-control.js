import { protectedHandler } from '../../src/utils/protected-handler.js';
import { parseJsonBody } from '../../src/utils/body.js';
import { loadMasterControl, updateMasterControl } from '../../src/backoffice/master-control.js';

export function createHandler({ verifyIdToken, env = process.env, load = loadMasterControl, update = updateMasterControl } = {}) {
  return protectedHandler({
    scope: 'backoffice',
    methods: ['GET', 'POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      if (event.httpMethod === 'POST') {
        return { control: await update(actor, parseJsonBody(event, 16 * 1024)) };
      }
      return { control: await load() };
    },
  });
}

export const handler = createHandler();
