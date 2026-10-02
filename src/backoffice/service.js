import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';
import { createGoldslotClient } from '../game/goldslotpalase.js';
import { loadPublicGameCatalog } from '../game/catalog.js';

const ALL_BACKOFFICE = new Set(['operator', 'finance', 'admin', 'superadmin']);
const OPERATIONS = new Set(['operator', 'admin', 'superadmin']);
const FINANCE = new Set(['finance', 'admin', 'superadmin']);
const ADMINS = new Set(['admin', 'superadmin']);

export function requireRole(actor, allowed = ALL_BACKOFFICE) {
  if (actor?.backoffice !== true || !allowed.has(actor.role)) throw new ServiceError('forbidden', 403);
}

export function isoTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function limitValue(value, fallback = 100, max = 200) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

function q(event, key) {
  return String(event?.queryStringParameters?.[key] ?? '').trim();
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function safeString(value, max = 200) {
  if (typeof value !== 'string') return '';
  const out = value.trim();
  return out.length <= max ? out : out.slice(0, max);
}

function docTime(data) {
  return isoTimestamp(data?.createdAt ?? data?.updatedAt);
}

async function recentDocs(db, collection, limit = 100) {
  const snapshot = await db.collection(collection).orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs;
}

export async function dashboard(actor, event, { db = getAdminDb(), env = process.env } = {}) {
  requireRole(actor);
  const range = ['1d', '7d', '30d'].includes(q(event, 'range')) ? q(event, 'range') : '7d';
  const days = range === '1d' ? 1 : range === '30d' ? 30 : 7;
  const since = Date.now() - days * 86400000;

  const [membersCount, ledgerDocs, transferDocs, auditDocs] = await Promise.all([
    db.collection('users').count().get(),
    recentDocs(db, 'ledger', 1000),
    recentDocs(db, 'providerTransfers', 250),
    recentDocs(db, 'auditEvents', 20),
  ]);

  const memberTotal = membersCount.data().count ?? 0;
  const canSeeFinance = FINANCE.has(actor.role);

  let depositToday = null;
  let withdrawToday = null;
  let pendingDeposits = null;
  let pendingWithdrawals = null;
  const todayKey = new Date().toISOString().slice(0, 10);

  if (canSeeFinance) {
    depositToday = 0;
    withdrawToday = 0;
    for (const doc of ledgerDocs) {
      const row = doc.data();
      const stamp = isoTimestamp(row.createdAt);
      if (!stamp || stamp.slice(0, 10) !== todayKey) continue;
      const source = lower(row.source);
      if (source.includes('deposit') && row.type === 'credit') depositToday += Number(row.amountMinor || 0);
      if ((source.includes('withdraw') || source.includes('payout')) && row.type === 'debit') withdrawToday += Number(row.amountMinor || 0);
    }

    const [depPending, wdPending] = await Promise.all([
      db.collection('depositRequests').where('status', '==', 'pending').limit(200).get(),
      db.collection('withdrawalRequests').where('status', '==', 'pending').limit(200).get(),
    ]);
    pendingDeposits = depPending.size;
    pendingWithdrawals = wdPending.size;
  }

  const pendingReconciliation = transferDocs.filter(doc => ['prepared', 'ambiguous'].includes(doc.data()?.status)).length;
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { label: d.toLocaleDateString('en-US', { weekday: 'short' }), deposit: 0, withdraw: 0 });
  }
  if (canSeeFinance) {
    for (const doc of ledgerDocs) {
      const row = doc.data();
      const stamp = isoTimestamp(row.createdAt);
      if (!stamp || Date.parse(stamp) < since) continue;
      const bucket = byDay.get(stamp.slice(0, 10));
      if (!bucket) continue;
      const source = lower(row.source);
      if (source.includes('deposit') && row.type === 'credit') bucket.deposit += Number(row.amountMinor || 0);
      if ((source.includes('withdraw') || source.includes('payout')) && row.type === 'debit') bucket.withdraw += Number(row.amountMinor || 0);
    }
  }

  const activity = auditDocs.slice(0, 6).map(doc => {
    const row = doc.data();
    return {
      title: safeString(row.action, 100) || 'Administrative activity',
      description: safeString(row.targetId ?? row.resource ?? '', 140) || 'Backoffice action',
      status: 'ok',
      timeLabel: isoTimestamp(row.createdAt)?.slice(11, 16) ?? '',
    };
  });

  return {
    members: memberTotal,
    depositToday,
    withdrawToday,
    pendingDeposits,
    pendingWithdrawals,
    pendingReconciliation,
    providerHealth: typeof env.GOLDSLOTPALASE_API_TOKEN === 'string' && env.GOLDSLOTPALASE_API_TOKEN.trim() ? 'configured' : 'unconfigured',
    transactionTrend: [...byDay.values()].slice(-7),
    activity,
    range,
    financeVisible: canSeeFinance,
  };
}

export async function listMembers(actor, event, { db = getAdminDb() } = {}) {
  requireRole(actor, OPERATIONS);
  const limit = limitValue(q(event, 'limit'), 100, 100);
  const search = lower(q(event, 'q'));
  const statusFilter = lower(q(event, 'status'));

  const snapshot = await db.collection('users').orderBy('createdAt', 'desc').limit(limit).get();
  const profiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const walletRefs = profiles.map(p => db.collection('wallets').doc(p.id));
  const wallets = walletRefs.length ? await db.getAll(...walletRefs) : [];
  const walletMap = new Map(wallets.filter(s => s.exists).map(s => [s.id, s.data()]));

  const items = profiles.map(p => {
    const wallet = walletMap.get(p.id);
    const status = wallet?.status === 'locked' ? 'blocked' : 'active';
    return {
      uid: p.id,
      username: safeString(p.username, 80),
      email: safeString(p.email, 160),
      displayName: safeString(p.displayName, 80),
      status,
      balance: Number.isSafeInteger(wallet?.balanceMinor) ? wallet.balanceMinor : 0,
      availableBalance: Number.isSafeInteger(wallet?.availableMinor) ? wallet.availableMinor : 0,
      onboardingCompleted: p.onboardingCompleted === true,
      createdAt: isoTimestamp(p.createdAt),
      lastLoginAt: isoTimestamp(p.lastLoginAt),
    };
  }).filter(item => {
    if (statusFilter && item.status !== statusFilter) return false;
    if (!search) return true;
    return [item.uid, item.username, item.email, item.displayName].some(value => lower(value).includes(search));
  });

  return { items, limit, filtered: Boolean(search || statusFilter) };
}

export async function listLedger(actor, event, { db = getAdminDb() } = {}) {
  requireRole(actor, FINANCE);
  const limit = limitValue(q(event, 'limit'), 100, 200);
  const snapshot = await db.collection('ledger').orderBy('createdAt', 'desc').limit(limit).get();
  const items = snapshot.docs.map(doc => {
    const row = doc.data();
    return {
      id: doc.id,
      createdAt: isoTimestamp(row.createdAt),
      reference: safeString(row.operationId ?? doc.id, 180),
      member: safeString(row.uid, 128),
      type: safeString(row.type, 32),
      source: safeString(row.source, 64),
      amount: Number.isSafeInteger(row.amountMinor) ? row.amountMinor : null,
      balanceAfter: Number.isSafeInteger(row.balanceAfterMinor) ? row.balanceAfterMinor : null,
      availableAfter: Number.isSafeInteger(row.availableAfterMinor) ? row.availableAfterMinor : null,
      currency: row.currency === 'IDR' ? 'IDR' : null,
    };
  });
  return { items, limit };
}

function paymentRequestView(doc, kind) {
  const row = doc.data();
  return {
    id: doc.id,
    reference: safeString(row.reference ?? row.operationId ?? doc.id, 160),
    member: safeString(row.uid ?? row.memberUid ?? row.username, 128),
    channel: safeString(row.channel ?? row.provider ?? row.method, 80),
    destinationMasked: safeString(row.destinationMasked ?? row.accountMasked, 80),
    amount: Number.isSafeInteger(row.amountMinor) ? row.amountMinor : Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    status: safeString(row.status, 40) || 'unknown',
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
    kind,
  };
}

export async function finance(actor, event, { db = getAdminDb() } = {}) {
  requireRole(actor, FINANCE);
  const kind = lower(q(event, 'kind')) || 'summary';
  const limit = limitValue(q(event, 'limit'), 100, 200);

  if (kind === 'deposits') {
    const docs = await recentDocs(db, 'depositRequests', limit);
    return { items: docs.map(doc => paymentRequestView(doc, 'deposit')), operational: false, adapterRequired: true };
  }
  if (kind === 'withdrawals') {
    const docs = await recentDocs(db, 'withdrawalRequests', limit);
    return { items: docs.map(doc => paymentRequestView(doc, 'withdrawal')), operational: false, adapterRequired: true };
  }
  if (kind === 'reconciliation') {
    const docs = await recentDocs(db, 'providerTransfers', limit);
    const items = docs.filter(doc => ['prepared', 'ambiguous'].includes(doc.data()?.status)).map(doc => {
      const row = doc.data();
      const before = Number.isSafeInteger(row.providerBalanceBefore) ? row.providerBalanceBefore : null;
      const after = Number.isSafeInteger(row.providerBalanceAfter) ? row.providerBalanceAfter : null;
      return {
        reference: doc.id,
        internalAmount: Number.isSafeInteger(row.amountMinor) ? row.amountMinor : null,
        externalAmount: Number.isSafeInteger(row.providerAmount) ? row.providerAmount : null,
        difference: Number.isSafeInteger(row.amountMinor) && Number.isSafeInteger(row.providerAmount) ? row.amountMinor - row.providerAmount : null,
        status: safeString(row.status, 40),
        updatedAt: isoTimestamp(row.updatedAt),
        providerBalanceBefore: before,
        providerBalanceAfter: after,
      };
    });
    return { items, source: 'providerTransfers' };
  }

  const [depPending, wdPending, ambiguous] = await Promise.all([
    db.collection('depositRequests').where('status', '==', 'pending').limit(200).get(),
    db.collection('withdrawalRequests').where('status', '==', 'pending').limit(200).get(),
    db.collection('providerTransfers').where('status', 'in', ['prepared', 'ambiguous']).limit(200).get(),
  ]);
  return {
    pendingDeposits: depPending.size,
    pendingWithdrawals: wdPending.size,
    callbackIssues: null,
    reconciliationDifference: null,
    providerReconciliationPending: ambiguous.size,
    paymentOperational: false,
    note: 'Payment adapter remains fail-closed until an approved adapter is registered.',
  };
}

export async function gameCatalog(actor, event, { env = process.env, clientFactory = createGoldslotClient, loadCatalog = loadPublicGameCatalog } = {}) {
  requireRole(actor, OPERATIONS);
  const catalog = await loadCatalog({ client: clientFactory({ env }) });
  const search = lower(q(event, 'q'));
  const status = lower(q(event, 'status'));
  const items = catalog.games.map(game => ({
    name: game.name,
    code: game.gameCode,
    category: game.category,
    providerStatus: game.launchEnabled ? 'active' : 'disabled',
    visible: game.active === true,
    providerId: game.providerId,
    providerName: game.providerName,
    imageUrl: game.imageUrl,
    updatedAt: catalog.syncedAt,
  })).filter(game => {
    if (status && game.providerStatus !== status) return false;
    return !search || lower(game.name).includes(search) || lower(game.code).includes(search);
  });
  return { items, provider: 'goldslotpalase', total: items.length, syncedAt: catalog.syncedAt };
}

export async function providerStatus(actor, event, { env = process.env, clientFactory = createGoldslotClient, loadCatalog = loadPublicGameCatalog } = {}) {
  requireRole(actor, OPERATIONS);
  const catalog = await loadCatalog({ client: clientFactory({ env }) });
  return {
    provider: 'goldslotpalase',
    status: 'healthy',
    gamesCount: catalog.games.length,
    lastSync: catalog.syncedAt,
    message: 'GoldslotPalase catalog API responded successfully.',
    capabilities: {
      catalog: true,
      launch: true,
      walletTransfer: env.GOLDSLOTPALASE_TRANSFER_ENABLED === 'true' && env.GOLDSLOTPALASE_IDR_SCALE === '1',
      balanceReconciliation: env.GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED === 'true',
      rtpGlobal: false,
      rtpPerGame: false,
      rtpPerUser: false,
      scatterControl: false,
    },
  };
}

export async function listAudit(actor, event, { db = getAdminDb() } = {}) {
  requireRole(actor, ADMINS);
  const limit = limitValue(q(event, 'limit'), 100, 200);
  const snapshot = await db.collection('auditEvents').orderBy('createdAt', 'desc').limit(limit).get();
  const items = snapshot.docs.map(doc => {
    const row = doc.data();
    return {
      id: doc.id,
      createdAt: isoTimestamp(row.createdAt),
      actor: safeString(row.actorUid ?? row.uid, 128),
      action: safeString(row.action, 120),
      resource: safeString(row.targetId ?? row.resource, 160),
      result: safeString(row.outcome ?? row.result, 40) || 'recorded',
      requestId: safeString(row.requestId, 160),
      revision: Number.isSafeInteger(row.revision) ? row.revision : null,
    };
  });
  return { items, limit };
}

const SITE_FIELDS = Object.freeze({
  siteName: 'text',
  supportLabel: 'text',
  announcement: 'text',
  banner1: 'url',
  banner2: 'url',
  banner3: 'url',
  loadingEnabled: 'boolean',
  loadingDuration: 'number',
  loadingLogo: 'url',
  seoTitle: 'text',
  seoDescription: 'text',
  seoCover: 'url',
});

function validateSiteSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_site_settings');
  const safe = {};
  for (const [key, value] of Object.entries(input)) {
    const kind = SITE_FIELDS[key];
    if (!kind) throw new ServiceError('unsupported_site_setting');
    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new ServiceError('invalid_site_setting');
      safe[key] = value;
      continue;
    }
    if (kind === 'number') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 3000) throw new ServiceError('invalid_site_setting');
      safe[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length > (key === 'announcement' || key === 'seoDescription' ? 1200 : 2048)) throw new ServiceError('invalid_site_setting');
    const cleaned = value.trim();
    if (kind === 'url' && cleaned) {
      let url; try { url = new URL(cleaned); } catch { throw new ServiceError('invalid_site_setting_url'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceError('invalid_site_setting_url');
    }
    safe[key] = cleaned;
  }
  return safe;
}

export async function websiteSettings(actor, event, input, { db = getAdminDb() } = {}) {
  requireRole(actor);
  const ref = db.collection('siteSettings').doc('member');
  if (event.httpMethod === 'GET') {
    const snapshot = await ref.get();
    return { settings: snapshot.exists ? snapshot.data() : {} };
  }

  requireRole(actor, ADMINS);
  if (input?.action !== 'update' || typeof input.section !== 'string') throw new ServiceError('invalid_site_settings_action');
  const safe = validateSiteSettings(input.settings);
  const auditRef = db.collection('auditEvents').doc();
  const now = FieldValue.serverTimestamp();
  await db.runTransaction(async tx => {
    tx.set(ref, { ...safe, updatedAt: now, updatedBy: actor.uid }, { merge: true });
    tx.create(auditRef, { action: 'website.settings.update', actorUid: actor.uid, targetId: input.section, createdAt: now });
  });
  const snapshot = await ref.get();
  return { settings: snapshot.data() };
}

function csvCell(value) {
  const s = String(value ?? '');
  return '"' + s.replaceAll('"', '""') + '"';
}

function csv(rows, columns) {
  const header = columns.map(c => csvCell(c.label)).join(',');
  const lines = rows.map(row => columns.map(c => csvCell(c.value(row))).join(','));
  return [header, ...lines].join('\n');
}

export async function report(actor, input, { db = getAdminDb() } = {}) {
  requireRole(actor, FINANCE);
  if (!input || input.action !== 'export' || !['finance', 'game', 'member'].includes(input.type)) throw new ServiceError('invalid_report_request');

  let content;
  if (input.type === 'finance') {
    const docs = await recentDocs(db, 'ledger', 1000);
    content = csv(docs.map(d => ({ id: d.id, ...d.data() })), [
      { label: 'Reference', value: r => r.operationId ?? r.id },
      { label: 'UID', value: r => r.uid },
      { label: 'Type', value: r => r.type },
      { label: 'Source', value: r => r.source },
      { label: 'Amount IDR', value: r => r.amountMinor },
      { label: 'Balance After', value: r => r.balanceAfterMinor },
      { label: 'Created At', value: r => isoTimestamp(r.createdAt) },
    ]);
  } else if (input.type === 'game') {
    const docs = await recentDocs(db, 'providerTransfers', 1000);
    content = csv(docs.map(d => ({ id: d.id, ...d.data() })), [
      { label: 'Transfer ID', value: r => r.id },
      { label: 'UID', value: r => r.uid },
      { label: 'Direction', value: r => r.direction },
      { label: 'Status', value: r => r.status },
      { label: 'Amount IDR', value: r => r.amountMinor },
      { label: 'Provider Amount', value: r => r.providerAmount },
      { label: 'Updated At', value: r => isoTimestamp(r.updatedAt) },
    ]);
  } else {
    requireRole(actor, ADMINS);
    const docs = await recentDocs(db, 'users', 1000);
    content = csv(docs.map(d => ({ id: d.id, ...d.data() })), [
      { label: 'UID', value: r => r.id },
      { label: 'Username', value: r => r.username },
      { label: 'Email', value: r => r.email },
      { label: 'Display Name', value: r => r.displayName },
      { label: 'Onboarding Complete', value: r => r.onboardingCompleted === true },
      { label: 'Created At', value: r => isoTimestamp(r.createdAt) },
    ]);
  }
  return {
    filename: `brandalbet-${input.type}-${new Date().toISOString().slice(0,10)}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  };
}
