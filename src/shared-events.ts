/**
 * Shared between `network-interceptor.ts` (runs in the page's MAIN world)
 * and `content.ts` (runs in the extension's isolated world). The two
 * worlds don't share JS globals, only the DOM/event system, so a
 * `CustomEvent` dispatched on `window` is how one relays data to the
 * other. Keeping the event name and payload shape here avoids duplicating
 * magic strings across the two bundles.
 */

export const LOGIN_NETWORK_RESULT_EVENT = "ka-login-poc:network-result";

export type LoginNetworkResultDetail = {
  /** Whether the HTTP response itself was ok (2xx). Not sufficient on its
   * own: Khan Academy's login mutation returns HTTP 200 even when the
   * credentials are wrong — the real result is in the response body. */
  httpOk: boolean;
  /** True if the GraphQL response contains a `loginWithPassword.error`. */
  hasError: boolean;
  /** Machine-readable error code from the response body, if any (e.g.
   * `"INVALID_CREDENTIALS"`), used only as a last-resort fallback message
   * if the page's own error text isn't readable in the DOM yet. */
  errorCode: string | null;
  /** True if the GraphQL response contains a logged-in `user`. */
  hasUser: boolean;
};
