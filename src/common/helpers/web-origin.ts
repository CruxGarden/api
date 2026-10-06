/**
 * The public website's origin, where `/{username}` and `/{username}/{slug}`
 * live. `PUBLIC_WEB_URL` names it for self-hosting; `BILLING_RETURN_URL` is
 * the same site and predates it.
 */
export function webOrigin(): string {
  return (
    process.env.PUBLIC_WEB_URL ||
    process.env.BILLING_RETURN_URL ||
    'https://crux.garden'
  ).replace(/\/+$/, '');
}
