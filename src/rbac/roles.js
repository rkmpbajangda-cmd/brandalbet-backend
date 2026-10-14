export const ROLES = Object.freeze([
  'member',
  'operator',
  'finance',
  'admin',
  'superadmin',
]);

export const BACKOFFICE_ROLES = Object.freeze([
  'operator',
  'finance',
  'admin',
  'superadmin',
]);

export function isKnownRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

/**
 * New Firebase Email/Password users do not receive custom claims automatically.
 * Permit an unclaimed, non-backoffice identity to enter member-only onboarding
 * and session endpoints so the profile can be created. Explicit non-member
 * roles and all backoffice identities remain denied.
 */
export function canAccessMember(decodedToken) {
  if (!decodedToken || decodedToken.backoffice === true) return false;
  return decodedToken.role === 'member'
    || decodedToken.role === undefined
    || decodedToken.role === null;
}

export function canAccessBackoffice(decodedToken) {
  return decodedToken?.backoffice === true && BACKOFFICE_ROLES.includes(decodedToken?.role);
}
