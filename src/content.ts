import { FALSE_LOGIN_CREDENTIALS, LOGIN_CREDENTIALS } from "./config";
import {
  ackForStart,
  domErrorOutcome,
  isLoginFormGone,
  outcomeFromNetworkDetail,
  resolveCredentialSet,
  type CredentialSet,
  type LoginOutcome,
  type StartLoginMessage,
  type TriggerAck,
} from "./login-logic";
import { LOGIN_NETWORK_RESULT_EVENT, type LoginNetworkResultDetail } from "./shared-events";

export type { CredentialSet, StartLoginMessage, TriggerAck };

/**
 * Content script for the Khan Academy login page.
 *
 * Does nothing on its own — it waits for a `START_LOGIN` message from the
 * extension popup, then:
 *   1. Shows a blur overlay over the page.
 *   2. Fills in the (hardcoded) credentials and submits the login form.
 *   3. Detects failure from (in order of preference): the login API's own
 *      response body (relayed from network-interceptor.ts, see there for
 *      why), Khan Academy's inline error message appearing/changing in
 *      the DOM, or a timeout. Detects success only once the login form
 *      has actually disappeared from the page — see waitForLoginOutcome
 *      for why that's stricter than it sounds.
 *   4. On failure: console.error()'s the error and shows it as a toast on
 *      top of the blur overlay. On success: removes the overlay.
 *
 * A failed attempt does NOT require a page reload before retrying — the
 * network-based detection in step 3 works just as well for a second (or
 * third...) attempt as it does for the first, including when two attempts
 * fail with the exact same error message (see network-interceptor.ts for
 * why that case matters).
 *
 * Selectors below were taken from the live DOM of
 * https://www.khanacademy.org/login and may need updating if Khan Academy
 * changes their markup.
 */

const SELECTORS = {
  username: "#username-field",
  password: "#current-password-field",
  submit: '[data-testid="log-in-submit-button"]',
  error: '#log-in-server-error, [role="alert"]',
} as const;

const OVERLAY_ID = "ka-login-poc-overlay";
const TOAST_ID = "ka-login-poc-toast";
const ELEMENT_WAIT_TIMEOUT_MS = 5000;
const SUBMIT_ENABLE_TIMEOUT_MS = 2000;
const LOGIN_OUTCOME_TIMEOUT_MS = 10000;
const GENERIC_FAILURE_MESSAGE =
  "Couldn't complete the automated login. See the browser console for details.";

const CREDENTIALS_BY_SET = {
  real: LOGIN_CREDENTIALS,
  false: FALSE_LOGIN_CREDENTIALS,
} as const;

// Guards against two overlapping runs from rapid double-triggers; it is
// NOT a "retry blocked" flag — a previous failure never prevents the next
// attempt.
let isRunning = false;

// Tracks the document-level listener used to keep focus trapped inside the
// overlay so Tab can't reach the blurred form underneath it.
let releaseFocusTrap: (() => void) | null = null;

/** Polls/observes the DOM for `selector` until it appears or times out. */
function waitForElement<T extends Element>(selector: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<T>(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector<T>(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for "${selector}" to appear.`));
    }, timeoutMs);
  });
}

/**
 * Khan Academy's login fields are React-controlled inputs. Setting
 * `.value` directly does not update React's internal state, so we use the
 * native input setter and then dispatch `input`/`change` events, which is
 * the standard workaround for scripting controlled inputs.
 */
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const prototype = Object.getPrototypeOf(input);
  const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function isButtonDisabled(button: HTMLButtonElement): boolean {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

/**
 * Khan Academy keeps the submit button disabled (via `aria-disabled`) until
 * React re-renders after the field values change. Clicking immediately
 * after setting the values can land before that re-render, so this waits
 * for the button to become enabled first. If it's still disabled once the
 * timeout elapses, we click anyway — better to try the click than to do
 * nothing silently.
 */
function waitUntilEnabled(button: HTMLButtonElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!isButtonDisabled(button)) {
      resolve();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!isButtonDisabled(button)) {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }
    });

    observer.observe(button, { attributes: true, attributeFilter: ["disabled", "aria-disabled"] });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve();
    }, timeoutMs);
  });
}

/**
 * Traps keyboard focus inside `container` while it's active, so the user
 * can't Tab into the blurred form underneath the overlay. The blur overlay
 * already blocks mouse clicks via `pointer-events`; this covers the
 * keyboard path that z-index/pointer-events alone don't.
 */
function trapFocusWithin(container: HTMLElement): () => void {
  container.tabIndex = -1;
  container.focus({ preventScroll: true });

  const handleFocusIn = (event: FocusEvent) => {
    if (!container.contains(event.target as Node)) {
      container.focus({ preventScroll: true });
    }
  };

  document.addEventListener("focusin", handleFocusIn, true);
  return () => document.removeEventListener("focusin", handleFocusIn, true);
}

function ensureOverlay(): HTMLDivElement {
  const existing = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (existing) {
    return existing;
  }

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "ka-login-poc-overlay";
  document.body.appendChild(overlay);

  releaseFocusTrap?.();
  releaseFocusTrap = trapFocusWithin(overlay);

  return overlay;
}

function removeOverlay(): void {
  releaseFocusTrap?.();
  releaseFocusTrap = null;
  document.getElementById(OVERLAY_ID)?.remove();
}

function removeToast(): void {
  document.getElementById(TOAST_ID)?.remove();
}

function showErrorToast(message: string): void {
  const overlay = ensureOverlay();

  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = "ka-login-poc-toast";
    overlay.appendChild(toast);
  }

  toast.textContent = message;
}

/**
 * Settles failure as soon as any of these fire:
 *
 *  1. (Primary) The `network-interceptor.ts` CustomEvent — reads the
 *     login API's own response body, so it correctly reports failure even
 *     when this attempt's error text is identical to a previous attempt's
 *     (React then has nothing to re-render, so signal #2 below would
 *     otherwise never fire for it).
 *  2. Khan Academy's inline error alert appearing/changing in the DOM —
 *     kept as a fallback in case the network signal is ever missed (e.g.
 *     Khan Academy renames the mutation).
 *
 * Success is deliberately NOT settled from the network signal alone: the
 * API can confirm a successful login before Khan Academy's SPA has
 * actually navigated away from /login, and removing the blur overlay at
 * that point would briefly expose the still-mounted login form — with the
 * real username and password length visible — before the page catches
 * up. Success only settles once the page has actually left /login *and*
 * the username field is no longer in the DOM, i.e. the login form itself
 * is gone, not just the URL.
 *
 * A fixed timeout is the last resort if none of the above ever fire.
 */
function waitForLoginOutcome(): Promise<LoginOutcome> {
  // On a retry, Khan Academy's error alert from the *previous* failed
  // attempt is often still sitting in the DOM untouched. The observer
  // below fires on every subtree mutation (e.g. an `aria-invalid` flip
  // when we set the field values) — without this baseline, it would
  // immediately "detect" that stale leftover and report failure before
  // this attempt's real response ever comes back. Only a DOM error that's
  // different from what was already there counts as a fresh result; an
  // identical repeat is left for the network signal (above) to catch.
  const initialErrorText = document.querySelector(SELECTORS.error)?.textContent?.trim() ?? null;

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result: LoginOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      observer.disconnect();
      window.removeEventListener(LOGIN_NETWORK_RESULT_EVENT, handleNetworkResult as EventListener);
      resolve(result);
    };

    const observer = new MutationObserver(() => {
      const outcome = domErrorOutcome(
        document.querySelector(SELECTORS.error)?.textContent,
        initialErrorText,
      );
      if (outcome) settle(outcome);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const pollTimer = setInterval(() => {
      const usernameFieldPresent = Boolean(document.querySelector(SELECTORS.username));
      if (isLoginFormGone(window.location.pathname, usernameFieldPresent)) {
        settle({ status: "success" });
      }
    }, 200);

    const readDomError = () => document.querySelector(SELECTORS.error)?.textContent;

    const handleNetworkResult = (event: Event) => {
      const detail = (event as CustomEvent<LoginNetworkResultDetail>).detail;
      const immediate = outcomeFromNetworkDetail(detail, readDomError());
      if (!immediate) return;

      if (immediate.status === "success") {
        // Intentionally not settled here — see the doc comment above.
        // The pollTimer above will settle it once the login form is
        // actually gone, not just "the API says it worked".
        return;
      }

      // Give React a tick to render the error text, but don't depend on
      // that actually changing the DOM (it may be identical to last time).
      setTimeout(() => {
        if (settled) return;
        const outcome = outcomeFromNetworkDetail(detail, readDomError());
        if (outcome) settle(outcome);
      }, 150);
    };
    window.addEventListener(LOGIN_NETWORK_RESULT_EVENT, handleNetworkResult as EventListener);

    const timeoutTimer = setTimeout(() => {
      settle({
        status: "error",
        message: "Login timed out waiting for a response from Khan Academy.",
      });
    }, LOGIN_OUTCOME_TIMEOUT_MS);
  });
}

async function runAutomatedLogin(credentialSet: CredentialSet): Promise<void> {
  const credentials = CREDENTIALS_BY_SET[credentialSet];
  isRunning = true;
  ensureOverlay();
  // Clear any error toast left over from a previous attempt so it can't
  // be mistaken for this attempt's result while this one is in flight.
  removeToast();

  try {
    const usernameField = await waitForElement<HTMLInputElement>(
      SELECTORS.username,
      ELEMENT_WAIT_TIMEOUT_MS,
    );
    const passwordField = await waitForElement<HTMLInputElement>(
      SELECTORS.password,
      ELEMENT_WAIT_TIMEOUT_MS,
    );
    const submitButton = await waitForElement<HTMLButtonElement>(
      SELECTORS.submit,
      ELEMENT_WAIT_TIMEOUT_MS,
    );

    setNativeInputValue(usernameField, credentials.username);
    setNativeInputValue(passwordField, credentials.password);

    // Wait for Khan Academy's React re-render to actually enable the
    // button before clicking it — clicking immediately can be a no-op if
    // the button is still disabled from the previous (empty) field state.
    await waitUntilEnabled(submitButton, SUBMIT_ENABLE_TIMEOUT_MS);
    submitButton.click();

    const outcome = await waitForLoginOutcome();

    if (outcome.status === "success") {
      console.log("[KA Login POC] Login succeeded.");
      removeOverlay();
    } else {
      console.error(`[KA Login POC] Login failed: ${outcome.message}`);
      showErrorToast(outcome.message);
    }
  } catch (error) {
    // These are internal/setup failures (e.g. a selector never appeared),
    // not messages from Khan Academy's own UI — keep the full detail in
    // the console and show a plain, non-technical message in the toast.
    const rawMessage = error instanceof Error ? error.message : String(error);
    console.error(`[KA Login POC] Login failed: ${rawMessage}`);
    showErrorToast(GENERIC_FAILURE_MESSAGE);
  } finally {
    isRunning = false;
  }
}

// All content scripts from this extension injected into a given frame
// share one isolated world (and therefore one `window`), regardless of
// whether they arrived via the declarative `content_scripts` match or a
// later on-demand `chrome.scripting.executeScript` call (see popup.ts).
// This guards against ending up with two independent listeners — and two
// independent `isRunning` states — in the same page.
const LISTENER_REGISTERED_FLAG = "__kaLoginPocListenerRegistered";
const globalFlags = window as unknown as Record<string, boolean>;

if (!globalFlags[LISTENER_REGISTERED_FLAG]) {
  globalFlags[LISTENER_REGISTERED_FLAG] = true;

  chrome.runtime.onMessage.addListener(
    (message: Partial<StartLoginMessage>, _sender, sendResponse) => {
      if (message?.type !== "START_LOGIN") {
        return undefined;
      }

      const credentialSet = resolveCredentialSet(message.credentials);
      const ack = ackForStart(isRunning);
      sendResponse(ack);

      if (ack.accepted) {
        console.log(`[KA Login POC] Starting login with ${credentialSet} credentials.`);
        void runAutomatedLogin(credentialSet);
      } else {
        console.warn(`[KA Login POC] Ignoring START_LOGIN: ${ack.reason}`);
      }

      return undefined;
    },
  );
}
