export function configurationReadiness(env = process.env) {
  const required = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'ALLOWED_MEMBER_ORIGINS',
    'ALLOWED_BACKOFFICE_ORIGINS',
    'GOLDSLOTPALASE_API_TOKEN',
    'PAYMENT_CONFIG_ENCRYPTION_KEY',
  ];
  const configuration = required.map(name => ({
    name,
    present: typeof env[name] === 'string' && env[name].trim().length > 0,
  }));

  const providerTransfer = {
    enabled: env.GOLDSLOTPALASE_TRANSFER_ENABLED === 'true',
    idrScaleVerified: env.GOLDSLOTPALASE_IDR_SCALE === '1',
    balanceReconciliationEnabled: env.GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED === 'true',
  };

  return {
    // This flag remains false until live/staging evidence and payment adapters pass.
    readyForRealMoney: false,
    configuration,
    bootstrapEnabled: env.BOOTSTRAP_ENABLED === 'true',
    integrations: {
      gameProvider: 'goldslotpalase',
      game: 'catalog_player_launch_transfer_state_machine_staging_gated',
      providerTransfer,
      payment: 'multi_connection_manager_adapters_pending',
      memberDeposit: 'adapter_pending',
      memberWithdrawal: 'adapter_pending',
    },
    checksRequired: [
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
