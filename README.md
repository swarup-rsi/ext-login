# Khan Academy Auto Login (POC)

Chrome (Manifest V3) extension proof-of-concept that:

1. Blurs the [Khan Academy login page](https://www.khanacademy.org/login) with a fixed overlay.
2. Fills in hardcoded credentials and submits the login form.
3. On failure, console-logs the error and shows it as a toast over the blur overlay.
4. On success, removes the overlay.

Login is triggered manually from the extension's toolbar popup — it does not run automatically on page load:

- **Login** uses `LOGIN_CREDENTIALS`.
- **Login with False Creds** uses `FALSE_LOGIN_CREDENTIALS` to exercise the failure path.

No reload is required between attempts, including repeated identical failures — see [`src/network-interceptor.ts`](src/network-interceptor.ts) and the comments in [`src/content.ts`](src/content.ts) for why that needs more than just watching the DOM. The popup also recovers on its own if the content script wasn't injected yet (e.g. you reached `/login` via a client-side link click rather than a full page load/reload) by injecting it on demand before retrying.

If the popup was opened while on the login page, it watches that tab and closes itself the moment it's no longer on `/login` (e.g. a successful login navigated away) — nothing to dismiss manually. It stays open through a failed attempt (still on `/login`), and if it's opened on some other page to begin with, it just shows the "open the login page first" message instead of closing.

## Setup

1. Put real credentials in [`src/config.ts`](src/config.ts) (`LOGIN_CREDENTIALS`); `FALSE_LOGIN_CREDENTIALS` holds the deliberately wrong set. There is no input UI by design — this is a POC.
2. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

   This produces a `dist/` folder containing the unpacked extension (bundled JS + manifest + static assets).

3. Load it in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - **Load unpacked** → select the `dist/` folder
4. Navigate to `https://www.khanacademy.org/login`, click the extension icon, then click **Login** or **Login with False Creds**.

## Development

- `npm run watch` — rebuilds the TS bundles on change (esbuild). Static files (`manifest.json`, `popup.html`, CSS) are only copied once per run of `build`/`watch` startup — rerun `npm run build` if you edit those.
- `npm test` — unit tests for the login decision rules (API body vs stale DOM error, credential routing, one-shot content-script injection).
- `npm run typecheck` — runs `tsc --noEmit` for type checking only (esbuild does the actual transpile, with no type checking).

## Notes

- Selectors in [`src/content.ts`](src/content.ts) (`#username-field`, `#current-password-field`, `[data-testid="log-in-submit-button"]`, `#log-in-server-error`) were taken from Khan Academy's live DOM and may break if they change their markup.
- The actual login result comes from the `loginWithPasswordMutation` GraphQL response body (read in the page's MAIN world by `network-interceptor.ts`), not just the HTTP status — Khan Academy's login API returns HTTP 200 even when the credentials are wrong.
- `src/config.ts` contains plaintext credentials once filled in — be careful about what you commit.
