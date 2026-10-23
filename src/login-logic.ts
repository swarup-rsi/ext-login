import type { LoginNetworkResultDetail } from "./shared-events";

export type TriggerAck = { accepted: true } | { accepted: false; reason: string };
export type CredentialSet = "real" | "false";
export type StartLoginMessage = { type: "START_LOGIN"; credentials: CredentialSet };

/**
 * Decision rules for the login flow, kept free of DOM and chrome.* so the
 * regressions we've already hit can be locked with unit tests:
 *   - HTTP 200 does not mean the login worked.
 *   - A DOM error left over from the previous attempt is not a new failure.
 *   - The same leftover text IS the message when the API itself says no.
 *   - A missed content script is injected once, then the message is retried.
 *   - A finished failure does not block the next attempt.
 */

export const LOGIN_URL_PREFIX = "https://www.khanacademy.org/login";
export const LOGIN_PATH = "/login";
export const LOGIN_MUTATION_MARKER = "loginWithPasswordMutation";

const ERROR_CODE_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Your login or password is incorrect.",
};

const REJECTED_LOGIN_MESSAGE = "Khan Academy rejected the login request.";

export type LoginOutcome = { status: "success" } | { status: "error"; message: string };

type LoginMutationBody = {
  data?: {
    loginWithPassword?: {
      error?: { code?: string } | null;
      user?: unknown;
    };
  };
};

export function isLoginPageUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith(LOGIN_URL_PREFIX));
}

export function isLoggedInNavigation(pathname: string): boolean {
  return !pathname.startsWith(LOGIN_PATH);
}

/**
 * Whether it's safe to remove the blur overlay. A route change can land
 * slightly before the old login form is actually unmounted (and the login
 * API can confirm success before either happens — see
 * outcomeFromNetworkDetail), so the URL alone is not enough: revealing the
 * page while the username/password fields are still mounted would expose
 * the real credential length for however long that gap lasts. Both
 * conditions must hold.
 */
export function isLoginFormGone(pathname: string, usernameFieldPresent: boolean): boolean {
  return isLoggedInNavigation(pathname) && !usernameFieldPresent;
}

export function isLoginMutationUrl(url: string): boolean {
  return url.includes(LOGIN_MUTATION_MARKER);
}

export function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function resolveCredentialSet(credentials: string | undefined): CredentialSet {
  return credentials === "false" ? "false" : "real";
}

/** A previous failure is intentionally not an input: retries stay allowed. */
export function ackForStart(isRunning: boolean): TriggerAck {
  if (isRunning) {
    return { accepted: false, reason: "A login attempt is already in progress." };
  }
  return { accepted: true };
}

export function interpretLoginMutation(body: unknown, httpOk: boolean): LoginNetworkResultDetail {
  const result = (body as LoginMutationBody | null)?.data?.loginWithPassword;
  return {
    httpOk,
    hasError: Boolean(result?.error),
    errorCode: result?.error?.code ?? null,
    hasUser: Boolean(result?.user),
  };
}

/**
 * DOM-only signal. `baseline` is the alert text already on the page when
 * this attempt started; the same string again is leftover, not a new result.
 */
export function domErrorOutcome(
  current: string | null | undefined,
  baseline: string | null,
): LoginOutcome | null {
  const text = current?.trim();
  if (!text || text === baseline) return null;
  return { status: "error", message: text };
}

/**
 * API-body signal. Unlike `domErrorOutcome`, an error here is real even
 * when the visible alert text is unchanged from the previous attempt.
 * `domErrorText` should be read after Khan Academy has had a chance to
 * render; this function does not wait.
 */
export function outcomeFromNetworkDetail(
  detail: LoginNetworkResultDetail | undefined,
  domErrorText: string | null | undefined,
): LoginOutcome | null {
  if (!detail) return null;
  if (detail.hasUser && !detail.hasError) return { status: "success" };

  if (detail.hasError) {
    const text = domErrorText?.trim();
    return {
      status: "error",
      message: text || ERROR_CODE_MESSAGES[detail.errorCode ?? ""] || REJECTED_LOGIN_MESSAGE,
    };
  }

  return null;
}

/**
 * First send is the normal path. If the content script isn't there yet,
 * inject it and try exactly once more — a second failure belongs to the caller.
 */
export async function deliverStartLogin<T>(
  send: () => Promise<T>,
  inject: () => Promise<void>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    console.warn(
      "[KA Login POC] Content script not reachable, injecting on demand before retrying:",
      error,
    );
    await inject();
    return await send();
  }
}
