import {
  interpretLoginMutation,
  isLoginMutationUrl,
  resolveRequestUrl,
} from "./login-logic.ts";
import { LOGIN_NETWORK_RESULT_EVENT } from "./shared-events.ts";

/**
 * Runs in the page's MAIN world (declared via `"world": "MAIN"` in
 * manifest.json), not the extension's isolated world that `content.ts`
 * runs in.
 *
 * Why this exists: Khan Academy's login form posts a GraphQL mutation
 * (`loginWithPasswordMutation`) that responds with HTTP 200 even when the
 * credentials are wrong — the actual outcome is only in the JSON body
 * (`data.loginWithPassword.error` vs `.user`). An isolated-world content
 * script cannot read the page's own `fetch`/`Response` objects (different
 * JS realm), so this script patches `window.fetch` in the page's own
 * realm, inspects the response for that one specific request, and relays
 * a small, structured result back via a `CustomEvent` on `window` — which,
 * unlike JS globals, is visible across both worlds since they share the
 * same DOM/EventTarget.
 *
 * This also sidesteps a real limitation of watching the DOM alone: if two
 * consecutive login attempts fail with the exact same error text, React
 * has nothing to re-render the second time, so a MutationObserver-based
 * detector never fires for that second attempt. Keying off the network
 * response instead makes repeated identical failures just as detectable
 * as the first one, so retries don't need a page reload to "reset" state.
 */

const originalFetch = window.fetch;

window.fetch = async function patchedFetch(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const response = await originalFetch.apply(this, args);

  const url = resolveRequestUrl(args[0]);
  if (!isLoginMutationUrl(url)) {
    return response;
  }

  // Clone so the page's own code still gets an unconsumed response body —
  // we're only observing, never altering the page's own request flow.
  response
    .clone()
    .json()
    .then((body: unknown) => {
      const detail = interpretLoginMutation(body, response.ok);
      window.dispatchEvent(new CustomEvent(LOGIN_NETWORK_RESULT_EVENT, { detail }));
    })
    .catch((error: unknown) => {
      // Not JSON, or some other parsing failure — let content.ts's
      // DOM/timeout fallbacks handle the outcome instead.
      console.warn("[KA Login POC] Could not parse login response body:", error);
    });

  return response;
};
