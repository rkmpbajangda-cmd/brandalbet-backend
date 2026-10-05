import { protectedHandler } from '../../src/utils/protected-handler.js';
import { configurationReadiness } from '../../src/config/readiness.js';
import { ServiceError } from '../../src/utils/errors.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { createGoldslotClient } from '../../src/game/goldslotpalase.js';

async function checkDependency(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { name, status: 'healthy', latencyMs: Date.now() - started, detail: value ?? null };
  } catch (error) {
    return {
      name,
      status: 'failed',
      latencyMs: Date.now() - started,
      detail: typeof error?.code === 'string' ? error.code : 'unavailable',
    };
  }
}

export function createHandler({ verifyIdToken, env = process.env } = {}) {
  return protectedHandler({
    scope: 'backoffice',
    verifyIdToken,
    env,
    run: async actor => {
      if (!['admin', 'superadmin'].includes(actor.role)) throw new ServiceError('forbidden', 403);
      const configuration = configurationReadiness(env);
      const firebase = await checkDependency('firebase', async () => {
        const db = getAdminDb(env);
        const snapshot = await db.collection('systemHealth').doc('probe').get();
        return { reachable: snapshot.exists || !snapshot.exists };
      });
      const goldslot = await checkDependency('goldslot', async () => {
        if (!env.GOLDSLOTPALASE_API_URL || !env.GOLDSLOTPALASE_API_TOKEN) throw new ServiceError('provider_unconfigured', 503);
        const result = await createGoldslotClient({ env }).agentInfo();
        return { result: result?.result ?? result?.code ?? 0 };
      });
      return {
        readiness: configuration,
        dependencies: { firebase, goldslot },
        checkedAt: new Date().toISOString(),
      };
    },
  });
}

export const handler = createHandler();
