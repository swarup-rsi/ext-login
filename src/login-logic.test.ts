import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ackForStart,
  deliverStartLogin,
  domErrorOutcome,
  interpretLoginMutation,
  isLoggedInNavigation,
  isLoginFormGone,
  isLoginPageUrl,
  outcomeFromNetworkDetail,
  resolveCredentialSet,
} from "./login-logic.ts";
import { LOGIN_NETWORK_RESULT_EVENT } from "./shared-events.ts";

const STALE_ERROR = "Your login or password is incorrect.";

const INVALID_CREDENTIALS_BODY = {
  data: {
    loginWithPassword: {
      error: { code: "INVALID_CREDENTIALS" },
      user: null,
    },
  },
};

const SIGNED_IN_BODY = {
  data: {
    loginWithPassword: {
      error: null,
      user: { kaid: "kaid_1" },
    },
  },
};

test("login outcome: API body wins, and a stale DOM error is not a new failure", () => {
  const invalid = interpretLoginMutation(INVALID_CREDENTIALS_BODY, true);
  const signedIn = interpretLoginMutation(SIGNED_IN_BODY, true);

  assert.deepEqual(invalid, {
    httpOk: true,
    hasError: true,
    errorCode: "INVALID_CREDENTIALS",
    hasUser: false,
  });
  assert.equal(signedIn.hasUser, true);
  assert.equal(signedIn.hasError, false);

  // HTTP status is not the result. A non-OK response with an error body still fails.
  assert.equal(interpretLoginMutation(INVALID_CREDENTIALS_BODY, false).hasError, true);

  // First paint of an alert counts. The same text on the next attempt does not.
  assert.deepEqual(domErrorOutcome(STALE_ERROR, null), { status: "error", message: STALE_ERROR });
  assert.equal(domErrorOutcome(STALE_ERROR, STALE_ERROR), null);
  assert.deepEqual(domErrorOutcome("Too many attempts.", STALE_ERROR), {
    status: "error",
    message: "Too many attempts.",
  });

  // The API saying "invalid" still fails when the DOM text never changes.
  assert.deepEqual(outcomeFromNetworkDetail(invalid, STALE_ERROR), {
    status: "error",
    message: STALE_ERROR,
  });
  // No alert text yet: fall back to the code, then to a generic rejection.
  assert.deepEqual(outcomeFromNetworkDetail(invalid, "  "), {
    status: "error",
    message: STALE_ERROR,
  });
  assert.deepEqual(
    outcomeFromNetworkDetail({ ...invalid, errorCode: "SOMETHING_ELSE" }, null),
    { status: "error", message: "Khan Academy rejected the login request." },
  );

  // A signed-in body is success even if the previous alert is still on the page.
  assert.deepEqual(outcomeFromNetworkDetail(signedIn, STALE_ERROR), { status: "success" });
  assert.equal(outcomeFromNetworkDetail(undefined, STALE_ERROR), null);
  assert.equal(outcomeFromNetworkDetail(interpretLoginMutation({}, true), null), null);

  assert.equal(isLoggedInNavigation("/profile/me/courses"), true);
  assert.equal(isLoggedInNavigation("/login"), false);
});

test("overlay removal: the URL alone is never enough, the form must be gone too", () => {
  // Regression: the login API can confirm success, and the URL can change,
  // before Khan Academy's SPA has actually unmounted the login form. Either
  // one treated as sufficient on its own would let the blur overlay come
  // down while the real username/password fields are still visible.

  // Still on /login: never safe, regardless of whether the form happens to
  // be present (this is the original bug — settling success off the API
  // response alone, before any navigation at all).
  assert.equal(isLoginFormGone("/login", true), false);
  assert.equal(isLoginFormGone("/login", false), false);

  // Off /login but the form is still mounted: the second-order case — a
  // route change landing a tick before the old form unmounts. Still not
  // safe.
  assert.equal(isLoginFormGone("/profile/me/courses", true), false);
  assert.equal(isLoginFormGone("/", true), false);

  // Only once both have actually happened is it safe to reveal the page.
  assert.equal(isLoginFormGone("/profile/me/courses", false), true);
  assert.equal(isLoginFormGone("/", false), true);
});

test("popup routing: credential set, login URL, and in-progress gate", () => {
  assert.equal(resolveCredentialSet("false"), "false");
  assert.equal(resolveCredentialSet("real"), "real");

  assert.equal(isLoginPageUrl("https://www.khanacademy.org/login?continue=%2F"), true);
  assert.equal(isLoginPageUrl("https://www.khanacademy.org/"), false);

  assert.deepEqual(ackForStart(false), { accepted: true });
  assert.deepEqual(ackForStart(true), {
    accepted: false,
    reason: "A login attempt is already in progress.",
  });
});

test("unreachable content script is injected once, then the send is retried", async () => {
  const missing = new Error("Could not establish connection. Receiving end does not exist.");

  let injections = 0;
  const injected = deliverStartLogin(
    () => Promise.reject(missing),
    async () => {
      injections += 1;
    },
  );
  await assert.rejects(injected, (error: unknown) => {
    assert.equal(error, missing);
    return true;
  });
  assert.equal(injections, 1);

  const sends: string[] = [];
  const ack = await deliverStartLogin(
    async () => {
      sends.push("send");
      if (sends.length === 1) throw missing;
      return { accepted: true as const };
    },
    async () => {
      sends.push("inject");
    },
  );
  assert.deepEqual(ack, { accepted: true });
  assert.deepEqual(sends, ["send", "inject", "send"]);
});

test("patched fetch reports only a parseable login mutation", async () => {
  const events: CustomEvent[] = [];
  const originalWindow = globalThis.window;

  globalThis.window = {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("not-json")) {
        return new Response("nope", { status: 200, headers: { "content-type": "text/plain" } });
      }
      const body = url.includes("loginWithPasswordMutation")
        ? INVALID_CREDENTIALS_BODY
        : { data: { other: true } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    dispatchEvent(event: Event) {
      events.push(event as CustomEvent);
      return true;
    },
  } as unknown as Window & typeof globalThis;

  try {
    await import("./network-interceptor.ts");
    const fetchPage = globalThis.window.fetch;

    await fetchPage("https://www.khanacademy.org/api/internal/graphql/otherQuery");
    await fetchPage(
      "https://www.khanacademy.org/api/internal/graphql/loginWithPasswordMutation?hash=1",
    );
    await fetchPage("https://www.khanacademy.org/api/internal/graphql/loginWithPasswordMutation/not-json");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, LOGIN_NETWORK_RESULT_EVENT);
    assert.deepEqual(
      events[0]?.detail,
      interpretLoginMutation(INVALID_CREDENTIALS_BODY, true),
    );
  } finally {
    globalThis.window = originalWindow;
  }
});
