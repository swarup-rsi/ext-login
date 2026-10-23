/**
 * Popup script. Each button sends a `START_LOGIN` message to the content
 * script running on the active tab (which must be the Khan Academy login
 * page), telling it which hardcoded credential set to use. All login UI
 * feedback (blur overlay + error toast) is rendered by the content script
 * on the page itself, not here.
 */

import type { CredentialSet } from "../content";
import { deliverStartLogin, isLoginPageUrl, type StartLoginMessage, type TriggerAck } from "../login-logic";

const loginButton = document.getElementById("login-button") as HTMLButtonElement;
const falseLoginButton = document.getElementById("false-login-button") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const buttons = [loginButton, falseLoginButton];

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setButtonsDisabled(disabled: boolean): void {
  for (const button of buttons) {
    button.disabled = disabled;
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const NAVIGATION_WATCH_INTERVAL_MS = 300;

/**
 * Closes the popup on its own once the watched tab is no longer on the
 * Khan Academy login page — whether that's because a triggered login
 * succeeded and the page navigated away, or for any other reason the tab
 * left /login while the popup happened to stay open. `host_permissions`
 * for khanacademy.org already makes `tab.url` visible here, so no extra
 * manifest permission is needed.
 */
function watchForLoginPageExit(tabId: number): void {
  const intervalId = setInterval(async () => {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      // The tab itself was closed — nothing left to watch.
      clearInterval(intervalId);
      return;
    }

    if (!isLoginPageUrl(tab.url)) {
      clearInterval(intervalId);
      window.close();
    }
  }, NAVIGATION_WATCH_INTERVAL_MS);
}

/**
 * Arms the watcher above only if the popup was opened while already on
 * the login page. If it was opened on some other page, there's nothing to
 * watch for — and the "open the login page first" message is still worth
 * leaving on screen rather than closing immediately.
 */
async function armAutoCloseOnceOffLoginPage(): Promise<void> {
  const tab = await getActiveTab();
  if (tab?.id && isLoginPageUrl(tab.url)) {
    watchForLoginPageExit(tab.id);
  }
}

/**
 * Chrome only runs declarative `content_scripts` on a real navigation
 * (full page load). Khan Academy is a React SPA, so landing on /login via
 * a client-side route change (e.g. clicking "Log in" from the homepage,
 * rather than a fresh load/reload of /login) never triggers that
 * injection — the content script simply isn't there yet, even though the
 * URL matches. Inject it on demand as a fallback in that case.
 */
async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  // MAIN world first (and awaited) so it has patched `fetch` before the
  // isolated-world script below can click submit and fire the request.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["network-interceptor.js"],
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function sendStartLogin(
  tabId: number,
  credentials: CredentialSet,
): Promise<TriggerAck> {
  const message: StartLoginMessage = { type: "START_LOGIN", credentials };
  const send = () => chrome.tabs.sendMessage<StartLoginMessage, TriggerAck>(tabId, message);
  return deliverStartLogin(send, () => injectContentScript(tabId));
}

async function triggerLogin(credentials: CredentialSet): Promise<void> {
  const tab = await getActiveTab();

  if (!tab?.id || !isLoginPageUrl(tab.url)) {
    setStatus("Open the Khan Academy login page first.");
    return;
  }

  setButtonsDisabled(true);
  setStatus("Triggering login…");

  try {
    const ack = await sendStartLogin(tab.id, credentials);

    if (ack?.accepted) {
      setStatus("Login triggered. Check the page for status.");
    } else {
      setStatus(ack?.reason ?? "The page declined to start the login.");
    }
  } catch (error) {
    setStatus("Could not reach the page. Reload the login page and try again.");
    console.error("[KA Login POC] Failed to send START_LOGIN message:", error);
  } finally {
    setButtonsDisabled(false);
  }
}

loginButton.addEventListener("click", () => void triggerLogin("real"));
falseLoginButton.addEventListener("click", () => void triggerLogin("false"));
void armAutoCloseOnceOffLoginPage();
