# Architecture

Codex Local Bridge is a Windows tray companion for Alorbach AI Subscription Gateway. It lets a browser page on a paired WordPress origin execute chat and image jobs through the logged-in Windows user's local Codex CLI session while the WordPress Gateway keeps ownership of plans, quotas, job signatures, audit records, and optional service fees.

## Components

### Electron tray app

Entry point: `src/main.js`

The tray app owns the user-facing desktop lifecycle:

- starts and stops the local HTTP bridge as a child process;
- shows the active bridge URL, pairing code, Codex login status, and paired WordPress origins;
- lets the user copy diagnostics without exposing stored bearer tokens;
- lets the user unpair an origin;
- optionally registers launch-on-login with Electron.

The app is intentionally tray-only. Closing normal windows is prevented because there are no windows to manage; quitting the tray app stops the local bridge process.

### Local HTTP bridge

Entry point: `src/server.js`

The bridge listens on `127.0.0.1` and defaults to port `8765`. It exposes a small JSON API under `/v1`. It accepts requests only from localhost sockets and relies on browser CORS plus per-origin pairing tokens to limit which browser origins can use the bridge.

The bridge does not call WordPress directly. It receives a WordPress-created job envelope from the browser, runs Codex locally, and returns the result to the browser. The browser then completes or fails the WordPress job with the original one-time token and request hash.

Execution requests are scheduled through an in-memory queue. The default limit is two parallel Codex jobs and can be changed with `ALORBACH_CODEX_MAX_CONCURRENT_JOBS`. Image generation jobs run exclusively because generated image detection currently watches the shared `CODEX_HOME/generated_images` directory.

### Codex CLI adapter

Entry point: `src/codex.js`

The adapter resolves and runs the local `codex` executable. On Windows, it prefers the real `codex.exe` from known installation locations before falling back to `where.exe codex`, which avoids common failures when the `codex.cmd` npm shim is not spawn-safe from a packaged app.

Runtime configuration:

- `ALORBACH_CODEX_BINARY`: explicit Codex executable path.
- `CODEX_HOME`: Codex profile directory. Defaults to `%USERPROFILE%\.codex`.
- `ALORBACH_CODEX_MAX_CONCURRENT_JOBS`: maximum parallel local Codex jobs. Defaults to `2`.
- `ALORBACH_CODEX_CHAT_TIMEOUT_MS`: chat timeout. Defaults to 600000.
- `ALORBACH_CODEX_IMAGE_TIMEOUT_MS`: image timeout. Defaults to 1800000.

Chat jobs run `codex exec` in an ephemeral temp directory and write the final assistant message to a temp output file. The bridge sends generated Codex instructions through stdin instead of a command-line prompt argument so large WordPress transcripts do not hit Windows process argument length limits. Data URL image attachments in chat content are decoded into temp files and passed with `codex exec --image`, so base64 image payloads do not count as prompt text. Image jobs run `codex exec`, watch `CODEX_HOME/generated_images`, and return the newest generated image as base64.

### Security state

Entry point: `src/security.js`

Pairing state is stored under:

```text
%USERPROFILE%\.alorbach-codex-bridge\state.json
```

The state file contains per-origin bearer tokens and pairing timestamps. The tray diagnostics intentionally omit token values.

Pairing codes are six digit, short-lived process values. After a successful pairing, the bridge generates a new pairing code.

### WordPress Gateway driver

Reference implementation:

```text
https://github.com/alorbach/alorbach-ai-subscription-gateway/blob/main/wordpress-plugin/includes/class-local-codex-bridge.php
https://github.com/alorbach/alorbach-ai-subscription-gateway/blob/main/wordpress-plugin/assets/js/demo-pages.js
```

The Gateway plugin is the production source of truth for job creation and completion. It validates model access, rate limits, quotas, duplicate request hashes, job ownership, job tokens, and result shape. The browser-side demo driver performs the handoff between WordPress and this local bridge.

## Production Flow

1. A logged-in WordPress user selects a `codex-local:*` model.
2. Browser requests Gateway config from `/wp-json/alorbach/v1/local-codex/config`.
3. Browser checks the tray bridge with `GET http://127.0.0.1:8765/v1/status`.
4. If no token is stored for the WordPress origin, browser asks the user for the tray pairing code and calls `/v1/pair`.
5. Browser asks WordPress to create a one-time local Codex job at `/wp-json/alorbach/v1/local-codex/jobs`.
6. WordPress returns `job_id`, `job_token`, `request_hash`, `request_id`, and the normalized payload.
7. Browser sends the job envelope to `/v1/chat` or `/v1/images` with the pairing token.
8. Bridge executes Codex locally and returns a normalized result.
9. Browser posts the result to `/wp-json/alorbach/v1/local-codex/jobs/{job_id}/complete`.
10. WordPress validates the one-time token and hash, records ledger/audit data, and returns the final response to the UI.

If the bridge call fails after a WordPress job was created, the browser posts to `/fail` so the duplicate hash can be cleared and the user can retry.
