import { protectedHandler } from '../../src/utils/protected-handler.js';
import { ServiceError } from '../../src/utils/errors.js';
import { getAdminDb } from '../../src/firebase/admin.js';
import { createGoldslotClient } from '../../src/game/goldslotpalase.js';
import { loadStoredGameCatalog } from '../../src/game/catalog.js';
import {
  getGoldslotProviderLedgerStatus,
  syncGoldslotProviderTransactions,
} from '../../src/game/provider-ledger.js';

const LIVE_CHECK_ROLES = new Set(['admin', 'superadmin']);

function parseBody(event) {
  if (!event.body) return {};
  if (event.body.length > 4096) throw new ServiceError('invalid_provider_request', 400);
  try { return JSON.parse(event.body); }
  catch { throw new ServiceError('invalid_json', 400); }
}

function capabilities(env) {
  return {
    catalog: true,
    launch: true,
    walletTransfer: env.GOLDSLOTPALASE_TRANSFER_ENABLED === 'true' && env.GOLDSLOTPALASE_IDR_SCALE === '1',
    balanceReconciliation: env.GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED === 'true',
    transactionHistory: true,
    transactionIncrementalSync: env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED === 'true',
    rewardPayout: env.REWARDS_PAYOUT_ENABLED === 'true',
    rtpGlobal: true,
    rtpPerGame: false,
    rtpPerUser: env.GOLDSLOTPALASE_INDIVIDUAL_RTP_ENABLED === 'true',
    scatterControl: false,
    onlineGames: true,
    bonusCall: env.GOLDSLOTPALASE_BONUS_CALL_ENABLED === 'true',
    freeRound: env.GOLDSLOTPALASE_FREEROUND_ENABLED === 'true',
    callback: Boolean(env['GOLDSLOTPALASE_CALLBACK_' + 'TOKEN']),
  };
}

async function snapshotStatus({ loadCatalog }) {
  try {
    const catalog = await loadCatalog();
    return {
      status: catalog.snapshotStale === true ? 'snapshot_stale' : 'snapshot_ready',
      gamesCount: catalog.games.length,
      lastSync: catalog.syncedAt,
      snapshotRevision: catalog.snapshotRevision ?? null,
      snapshotStale: catalog.snapshotStale === true,
      message: catalog.snapshotStale === true
        ? 'Snapshot katalog tersedia tetapi berumur lebih dari 7 hari. Sync manual bila ingin memperbarui.'
        : 'Snapshot katalog siap. Tidak ada panggilan live ke GoldslotPalase.',
    };
  } catch (error) {
    if (error?.code === 'catalog_not_initialized') {
      return {
        status: 'snapshot_missing',
        gamesCount: 0,
        lastSync: null,
        snapshotRevision: null,
        snapshotStale: true,
        message: 'Katalog belum pernah disinkronkan. Jalankan Sync Catalog sekali dari backoffice.',
      };
    }
    throw error;
  }
}

export function createHandler({
  verifyIdToken,
  env = process.env,
  loadCatalog = loadStoredGameCatalog,
  clientFactory = createGoldslotClient,
  ledgerStatus = getGoldslotProviderLedgerStatus,
  syncTransactions = syncGoldslotProviderTransactions,
  dbFactory = getAdminDb,
} = {}) {
  return protectedHandler({
    scope: 'backoffice',
    methods: ['GET', 'POST'],
    verifyIdToken,
    env,
    run: async (actor, event) => {
      const snapshot = await snapshotStatus({ loadCatalog });
      const db = dbFactory(env);
      const transactions = await ledgerStatus({ db, env });

      if (event.httpMethod === 'GET') {
        return {
          provider: 'goldslotpalase',
          ...snapshot,
          transactions,
          capabilities: capabilities(env),
          liveChecked: false,
        };
      }

      const input = parseBody(event);
      if (!LIVE_CHECK_ROLES.has(actor.role)) throw new ServiceError('forbidden', 403);

      if (input.action === 'check') {
        // Explicit admin action only: opening/reloading the page never calls the provider.
        await clientFactory({ env }).agentInfo();
        return {
          provider: 'goldslotpalase',
          ...snapshot,
          transactions,
          status: 'healthy',
          message: 'GoldslotPalase merespons pemeriksaan manual admin.',
          capabilities: capabilities(env),
          liveChecked: true,
          checkedAt: new Date().toISOString(),
        };
      }

      if (input.action === 'sync-transactions') {
        const sync = await syncTransactions({ db, env, clientFactory });
        return {
          provider: 'goldslotpalase',
          transactions: sync,
          capabilities: capabilities(env),
        };
      }

      throw new ServiceError('invalid_provider_action', 400);
    },
  });
}

export const handler = createHandler();
