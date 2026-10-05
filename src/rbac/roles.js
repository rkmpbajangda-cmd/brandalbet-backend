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

export function canAccessMember(decodedToken) {
  return decodedToken?.backoffice !== true && decodedToken?.role === 'member';
}

export function canAccessBackoffice(decodedToken) {
  return decodedToken?.backoffice === true && BACKOFFICE_ROLES.includes(decodedToken?.role);
}
