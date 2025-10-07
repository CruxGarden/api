/**
 * Checks if a role is an admin-level role (admin or keeper)
 */
export function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'keeper';
}
