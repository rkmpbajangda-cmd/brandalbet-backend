import { normalizeAssetBaseUrl } from './assets.js';

function present(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

function firebaseProjectMatch(env) {
  if (!present(env, 'FIREBASE_SERVICE_ACCOUNT_JSON') || !present(env, 'FIREBASE_PROJECT_ID')) return false;
  try {
    const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    return typeof parsed?.project_id === 'string' && parsed.project_id.trim() === env.FIREBASE_PROJECT_ID.trim();
  } catch {
    return false;
  }
}

export function configurationReadiness(env = process.env) {
  const firebaseBundled = present(env, 'FIREBASE_SERVICE_ACCOUNT_JSON');
  const firebaseSplit = present(env, 'FIREBASE_PROJECT_ID')
    && present(env, 'FIREBASE_CLIENT_EMAIL')
    && present(env, 'FIREBASE_PRIVATE_KEY');
  const assetCdnBaseUrl = normalizeAssetBaseUrl(env);

  const configuration = [
    { name: 'FIREBASE_ADMIN_CREDENTIALS', present: firebaseBundled || firebaseSplit },
    { name: 'FIREBASE_ADMIN_PROJECT_MATCH', present: firebaseBundled ? firebaseProjectMatch(env) : firebaseSplit },
    { name: 'BOOTSTRAP_SUPERADMIN_UID', present: present(env, 'BOOTSTRAP_SUPERADMIN_UID') },
    { name: 'ALLOWED_MEMBER_ORIGINS', present: present(env, 'ALLOWED_MEMBER_ORIGINS') },
    { name: 'ALLOWED_BACKOFFICE_ORIGINS', present: present(env, 'ALLOWED_BACKOFFICE_ORIGINS') },
    { name: 'GOLDSLOTPALASE_API_TOKEN', present: present(env, 'GOLDSLOTPALASE_API_TOKEN') },
    { name: 'GOLDSLOTPALASE_API_URL', present: present(env, 'GOLDSLOTPALASE_API_URL') },
    { name: 'GOLDSLOTPALASE_IDR_SCALE', present: present(env, 'GOLDSLOTPALASE_IDR_SCALE') },
    { name: 'GOLDSLOTPALASE_LANGUAGE', present: present(env, 'GOLDSLOTPALASE_LANGUAGE') },
    { name: 'GOLDSLOTPALASE_MAX_CONCURRENT_CALLS', present: present(env, 'GOLDSLOTPALASE_MAX_CONCURRENT_CALLS') },
    { name: 'GOLDSLOTPALASE_TRANSACTION_MIN_INTERVAL_MS', present: present(env, 'GOLDSLOTPALASE_TRANSACTION_MIN_INTERVAL_MS') },
    { name: 'GOLDSLOTPALASE_LAUNCH_URL_TTL_MS', present: present(env, 'GOLDSLOTPALASE_LAUNCH_URL_TTL_MS') },
    { name: 'GOLDSLOTPALASE_TRANSACTION_RETENTION_DAYS', present: present(env, 'GOLDSLOTPALASE_TRANSACTION_RETENTION_DAYS') },
    { name: 'GOLDSLOTPALASE_ROUND_DETAILS_DAYS', present: present(env, 'GOLDSLOTPALASE_ROUND_DETAILS_DAYS') },
    { name: 'GOLDSLOTPALASE_CALLBACK_TOKEN', present: present(env, 'GOLDSLOTPALASE_CALLBACK_TOKEN') },
    { name: 'GOLDSLOTPALASE_CALLBACK_HTTPS_ONLY', present: present(env, 'GOLDSLOTPALASE_CALLBACK_HTTPS_ONLY') },
    { name: 'GOLDSLOTPALASE_CALLBACK_TIMEOUT_MS', present: present(env, 'GOLDSLOTPALASE_CALLBACK_TIMEOUT_MS') },
    { name: 'GOLDSLOTPALASE_CALLBACK_RETRY_ATTEMPTS', present: present(env, 'GOLDSLOTPALASE_CALLBACK_RETRY_ATTEMPTS') },
    { name: 'GOLDSLOTPALASE_CALLBACK_RETRY_INTERVAL_MS', present: present(env, 'GOLDSLOTPALASE_CALLBACK_RETRY_INTERVAL_MS') },
    { name: 'GOLDSLOTPALASE_INDIVIDUAL_RTP_ENABLED', present: present(env, 'GOLDSLOTPALASE_INDIVIDUAL_RTP_ENABLED') },
    { name: 'GOLDSLOTPALASE_BONUS_CALL_ENABLED', present: present(env, 'GOLDSLOTPALASE_BONUS_CALL_ENABLED') },
    { name: 'GOLDSLOTPALASE_FREEROUND_ENABLED', present: present(env, 'GOLDSLOTPALASE_FREEROUND_ENABLED') },
    { name: 'PAYMENT_CONFIG_ENCRYPTION_KEY', present: present(env, 'PAYMENT_CONFIG_ENCRYPTION_KEY') },
  ];

  const providerTransfer = {
    enabled: env.GOLDSLOTPALASE_TRANSFER_ENABLED === 'true',
    idrScaleVerified: env.GOLDSLOTPALASE_IDR_SCALE === '1',
    balanceReconciliationEnabled: env.GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED === 'true',
  };

  return {
    readyForRealMoney: false,
    configuration,
    bootstrapEnabled: env.BOOTSTRAP_ENABLED === 'true',
    bootstrapTargetConfigured: present(env, 'BOOTSTRAP_SUPERADMIN_UID'),
    integrations: {
      firebase: {
        credentialsConfigured: firebaseBundled || firebaseSplit,
        projectMatches: firebaseBundled ? firebaseProjectMatch(env) : firebaseSplit,
        projectId: present(env, 'FIREBASE_PROJECT_ID') ? env.FIREBASE_PROJECT_ID : null,
      },
      assets: {
        configured: true,
        strategy: assetCdnBaseUrl ? 'custom-cdn-override' : 'cloudflare-workers-static-assets',
        customBaseUrlConfigured: Boolean(assetCdnBaseUrl),
      },
      gameProvider: 'goldslotpalase',
      game: 'catalog_player_launch_transfer_state_machine_staging_gated',
      providerTransfer,
      payment: 'multi_connection_manager_adapters_pending',
      paymentVaultConfigured: present(env, 'PAYMENT_CONFIG_ENCRYPTION_KEY'),
      memberDeposit: 'adapter_pending',
      memberWithdrawal: 'adapter_pending',
    },
    checksRequired: [
      'cloudflare_static_asset_smoke_test',
      'firebase_admin_project_match',
      'superadmin_bootstrap_target',
      'goldslot_authenticated_staging_connectivity',
      'goldslot_currency_and_idr_scale',
      'goldslot_catalog_launch_transfer_reconciliation',
      'payment_contract_and_adapter',
      'deposit_callback_and_reconciliation',
      'withdrawal_adapter_and_reconciliation',
      'live_auth_rbac',
      'firestore_rules_and_indexes',
      'wallet_concurrency_and_recovery',
      'end_to_end_browser',
      'backup_restore',
    ],
  };
}
