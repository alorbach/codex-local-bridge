# Operations

## User Installation

1. Install Codex CLI for the Windows user who will run the tray app.
2. Run `codex login` in that same Windows account.
3. Install or unzip the latest Codex Local Bridge release.
4. Start `Codex Local Bridge`.
5. Open the tray menu and confirm `Codex: Ready`.
6. In WordPress, enable Local Codex and keep the bridge URL at `http://127.0.0.1:8765` unless a custom port is required.
7. Pair the WordPress origin with the six digit tray code when prompted.

## Development Commands

Install dependencies:

```powershell
npm ci
```

Run tests:

```powershell
npm test
```

Run the server without Electron:

```powershell
npm run serve
```

Run the tray app:

```powershell
npm start
```

Limit local Codex parallelism for a development run:

```powershell
$env:ALORBACH_CODEX_MAX_CONCURRENT_JOBS = '2'
npm start
```

Run the standalone HTTP example:

```powershell
npm run example:http
```

Check local Codex readiness:

```powershell
npm run smoke
```

Generate icons:

```powershell
npm run icons
```

Build Windows artifacts:

```powershell
npm run dist:win
```

## Build Outputs

Windows builds are written to `dist/`.

Release artifact names include the semantic version and build number:

```text
Codex-Local-Bridge-1.0.1-build.42-win-x64.exe
Codex-Local-Bridge-1.0.1-build.42-win-x64.zip
```

Local builds increment `.build/build-number`. GitHub Actions builds use `GITHUB_RUN_NUMBER`.

## Release

Push a version tag:

```powershell
git tag v1.0.1
git push origin v1.0.1
```

The release workflow:

1. checks out the repo;
2. derives the package version from the tag;
3. installs Node dependencies;
4. generates icons;
5. syntax-checks JavaScript files;
6. runs tests;
7. builds the Windows installer and portable ZIP;
8. publishes a GitHub Release with the generated assets.

## Diagnostics

Use the tray menu:

![Codex Local Bridge tray menu](images/tray-menu.png)

- double-clicking the tray icon opens `/status`;
- `Open status page` opens `/status`;
- `Open status JSON` opens `/v1/status`;
- `Copy diagnostics` copies a JSON diagnostic payload without bearer token values;
- `Open bridge data folder` opens `%USERPROFILE%\.alorbach-codex-bridge`;
- `Refresh Codex status` rechecks `codex --version` and `codex login status`.

The tray icon animates while jobs are running and changes color for queued, failed, and stopped states. Mouse-over text and the tray menu show running and queued job counts plus request IDs, job types, models, and elapsed time. Prompt and message content are not shown.

Failed bridge requests include a `debug_help` object in the JSON response. It points to `/status`, `/v1/status`, the request id when available, and safe checks such as Codex login status, pairing state, and tray diagnostics. The `/status` page auto-refreshes and shows bounded live Codex session output for running jobs, then keeps recent failed jobs with stderr/stdout/last response text when available.

Useful direct checks:

```powershell
codex --version
codex login status
npm run smoke
```

If the app resolves the wrong Codex command on Windows, set:

```powershell
$env:ALORBACH_CODEX_BINARY = '<path-to-codex.exe>'
npm start
```

## Common Failures

### Bridge not reachable

Check that the tray app is running and that no other process owns the configured port. The bridge binds only to `127.0.0.1`.

### Codex installed but not ready

Run `codex login` from the same Windows account as the tray app. The bridge checks `CODEX_HOME\auth.json` and `codex login status`.

### Pairing fails

Confirm the browser page is served from `http` or `https`, not `file://`. Pairing is origin-based, so `http://localhost:8787` and `http://127.0.0.1:8787` are different origins.

### Requests return 403 after pairing

Clear the browser's stored token for the origin and pair again. Also check the tray menu for the paired origins list.

### Image request succeeds in Codex but bridge returns no image

The bridge detects new files under `CODEX_HOME\generated_images`. Confirm Codex writes generated images there for the current `CODEX_HOME`.

Image jobs run exclusively even when multiple chat jobs are allowed, because image result detection uses the shared generated-images directory.

### WordPress retry says duplicate request

The browser likely created a Gateway job and failed before calling `/fail`. The Gateway duplicate lock expires with the local job TTL, currently 900 seconds.
