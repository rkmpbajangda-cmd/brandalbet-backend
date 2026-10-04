import { normalizeAssetBaseUrl } from './assets.js';

function present(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

export function configurationReadiness(env = process.env) {
  const firebaseBundled = present(env, 'FIREBASE_SERVICE_ACCOUNT_JSON');
  const firebaseSplit = present(env, 'FIREBASE_PROJECT_ID')
    && present(env, 'FIREBASE_CLIENT_EMAIL')
    && present(env, 'FIREBASE_PRIVATE_KEY');
  const assetCdnBaseUrl = normalizeAssetBaseUrl(env);

  const configuration = [
    { name: 'FIREBASE_ADMIN_CREDENTIALS', present: firebaseBundled || firebaseSplit },
    { name: 'ALLOWED_MEMBER_ORIGINS', present: present(env, 'ALLOWED_MEMBER_ORIGINS') },
    { name: 'ALLOWED_BACKOFFICE_ORIGINS', present: present(env, 'ALLOWED_BACKOFFICE_ORIGINS') },
    { name: 'GOLDSLOTPALASE_API_TOKEN', present: present(env, 'GOLDSLOTPALASE_API_TOKEN') },
    { name: 'GOLDSLOTPALASE_API_URL', present: present(env, 'GOLDSLOTPALASE_API_URL') },
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
    integrations: {
      assets: {
        configured: true,
        strategy: assetCdnBaseUrl ? 'custom-cdn-override' : 'cloudflare-workers-static-assets',
        customBaseUrlConfigured: Boolean(assetCdnBaseUrl),
      },
      gameProvider: 'goldslotpalase',
      game: 'catalog_player_launch_transfer_state_machine_staging_gated',
      providerTransfer,
      payment: 'multi_connection_manager_adapters_pending',
      memberDeposit: 'adapter_pending',
      memberWithdrawal: 'adapter_pending',
    },
    checksRequired: [
      'cloudflare_static_asset_smoke_test',
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
