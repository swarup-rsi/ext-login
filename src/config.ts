/**
 * POC ONLY — hardcoded Khan Academy credentials used for automated login.
 *
 * Per project requirements there is intentionally no input UI for entering
 * credentials — replace the placeholder values below directly in this file.
 *
 * ⚠️ These are plaintext in the extension bundle. Do not use real/production
 * credentials beyond local testing, and be careful about what you commit.
 */
export const LOGIN_CREDENTIALS = {
  username: "agentsmith0199@gmail.com",
  password: "AgentSmith",
} as const;

/**
 * Deliberately wrong credentials, used by the "Login with False Creds"
 * button to exercise the failure path (error toast over the blur overlay).
 */
export const FALSE_LOGIN_CREDENTIALS = {
  username: "swarup.suryawanshi@example.com",
  password: "password",
} as const;