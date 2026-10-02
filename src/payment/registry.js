// Register a production adapter here only after implementing and testing its actual API,
// signature verification, status query, idempotency and reconciliation contracts.
// A connection form alone cannot turn arbitrary credentials into a working payment API.
export const PAYMENT_ADAPTERS = Object.freeze({});
export function adapterFor(provider, adapters = PAYMENT_ADAPTERS) {
  return Object.hasOwn(adapters, provider) ? adapters[provider] : null;
}
export function connectionReadiness(connection, adapters = PAYMENT_ADAPTERS) {
  const adapter = adapterFor(connection.provider, adapters);
  const missingCredentials = adapter
    ? adapter.requiredCredentials.filter(field => !connection.credentialFields?.includes(field)) : [];
  const adapterAvailable = Boolean(adapter?.productionApproved);
  return {
    adapterAvailable,
    missingCredentials,
    status: !adapterAvailable ? 'adapter_unavailable' : missingCredentials.length ? 'credentials_incomplete' : 'configured_not_verified',
    operational: false,
  };
}
