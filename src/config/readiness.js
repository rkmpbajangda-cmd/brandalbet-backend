export function configurationReadiness(env = process.env) {
  const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'ALLOWED_MEMBER_ORIGINS', 'ALLOWED_BACKOFFICE_ORIGINS', 'GOLDSLOTPALASE_API_TOKEN'];
  const configuration = required.map(name => ({ name, present: typeof env[name] === 'string' && env[name].trim().length > 0 }));
  return { readyForRealMoney: false, configuration,
    bootstrapEnabled: env.BOOTSTRAP_ENABLED === 'true',
    integrations: { gameProvider: 'goldslotpalase', game: 'client_prepared_workflows_not_implemented', payment: 'not_implemented', withdrawals: 'not_implemented' },
    checksRequired: ['provider_contract_and_adapter', 'payment_contract_and_adapter', 'withdrawal_and_reconciliation',
      'live_auth_rbac', 'firestore_rules_and_indexes', 'wallet_concurrency_and_recovery', 'end_to_end_sandbox', 'backup_restore'] };
}
