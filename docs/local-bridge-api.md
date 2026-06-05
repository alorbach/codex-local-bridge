# Local Bridge API

Default base URL:

```text
http://127.0.0.1:8765
```

The port can be changed with `ALORBACH_CODEX_BRIDGE_PORT`.

All routes return JSON and set `Cache-Control: no-store`. The bridge accepts only localhost socket clients. Browser callers must use an `http` or `https` origin; `file://` origins are rejected.

## Headers

Paired routes require:

```http
Origin: http://127.0.0.1:8787
Content-Type: application/json
X-Alorbach-Bridge-Token: <pairing-token>
X-Alorbach-Request-Id: <request-id>
```

`X-Alorbach-Request-Id` is currently forwarded as a request identity header for clients and CORS, while `request_id` in the JSON body is the required bridge-side field for execution routes.

## Body Limit

The maximum JSON request body is 12 MiB. This is intended to support normal chat payloads and image prompts, not binary uploads.

## `GET /status`

Shows a minimal local HTML status page for the same runtime data exposed by `GET /v1/status`. The page uses the local job event stream to append bounded live Codex session output for running jobs without repeatedly reloading the full status payload. The tray app opens this page when the tray icon is double-clicked.

## `GET /v1/status`

Checks bridge and local Codex readiness. This route does not require pairing.

Example response:

```json
{
  "success": true,
  "message": "Local Codex CLI is installed and logged in.",
  "details": {
    "codex_binary": "<path-to-codex-executable>",
    "codex_home": "<user-home>\\.codex",
    "auth_path": "<user-home>\\.codex\\auth.json",
    "generated_images_dir": "<user-home>\\.codex\\generated_images",
    "version": "codex ...",
    "login_status": "Logged in ..."
  },
  "bridge": {
    "version": "1.0.1",
    "paired_origins": [
      "http://127.0.0.1:8787"
    ]
  },
  "jobs": {
    "running_count": 1,
    "queued_count": 0,
    "max_concurrent": 2,
    "active": [
      {
        "request_id": "request-123",
        "short_request_id": "request-123",
        "type": "chat",
        "model": "codex-local:auto",
        "status": "running",
        "elapsed_ms": 1200
      }
    ]
  }
}
```

`success: false` means the tray bridge is reachable but Codex is missing, not executable, or not logged in for the current Windows user.

`jobs` reports in-memory local bridge activity. It never includes prompt text or message content. `active` contains currently running jobs, while queued and recent entries may also be present for tray/status diagnostics.

## `GET /v1/status/events`

Streams job-state updates as server-sent events for the local status page. This route does not require pairing and emits `jobs` events whose JSON payload matches the `jobs` object from `GET /v1/status`.

## `GET /v1/capabilities`

Returns capability metadata for the bridge, local Codex executable, optional video provider, and media analysis support. This route does not require pairing.

Example response:

```json
{
  "success": true,
  "bridge": {
    "version": "1.0.2"
  },
  "codex": {
    "binary": "<path-to-codex-executable>",
    "version": "codex-cli 0.137.0"
  },
  "features": {
    "chat": true,
    "images": true,
    "media_analysis": true,
    "structured_exec_json": true,
    "output_schema": true,
    "image_attachments": true,
    "app_server": true
  },
  "video": {
    "enabled": false,
    "configured": false,
    "provider": "openai-videos-api",
    "models": ["sora-2", "sora-2-pro"]
  },
  "media_analysis": {
    "enabled": true,
    "provider": "local-codex-vision",
    "ffmpeg_available": true
  }
}
```

## `POST /v1/pair`

Pairs a browser origin with the bridge.

Request:

```json
{
  "origin": "http://127.0.0.1:8787",
  "pairing_code": "123456"
}
```

Response:

```json
{
  "success": true,
  "origin": "http://127.0.0.1:8787",
  "token": "..."
}
```

Store the token in browser storage scoped to the origin. Treat it as a bearer secret. If pairing succeeds, the bridge rotates the tray pairing code.

## `POST /v1/unpair`

Removes the pairing for the request origin.

Request headers must include `Origin` and `X-Alorbach-Bridge-Token`.

Response:

```json
{
  "success": true
}
```

## `GET /v1/models`

Returns local model IDs after pairing.

Response:

```json
{
  "success": true,
  "models": {
    "text": [
      "codex-local:auto"
    ],
    "image": [
      "codex-local:image"
    ]
  }
}
```

If `CODEX_HOME/models_cache.json` exists, additional text model IDs from that cache are returned as `codex-local:<id>`.

## `POST /v1/chat`

Runs a local Codex chat completion.

Request:

```json
{
  "job_token": "<wordpress-job-token>",
  "request_hash": "<wordpress-request-hash>",
  "request_id": "<wordpress-request-id>",
  "payload": {
    "model": "codex-local:auto",
    "messages": [
      {
        "role": "user",
        "content": "Write a short status line."
      }
    ],
    "max_tokens": 256
  }
}
```

Response:

```json
{
  "success": true,
  "response": {
    "id": "local-codex-...",
    "object": "chat.completion",
    "model": "codex-local:auto",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "..."
        },
        "finish_reason": "stop"
      }
    ],
    "usage": {
      "total_tokens": 0,
      "local_unmetered": true
    }
  }
}
```

The bridge requires `job_token`, `request_hash`, and `request_id` to be present. In production, these fields come from WordPress and are validated when the browser posts the result back to Gateway.

## `POST /v1/images`

Runs a local Codex image request.

Request:

```json
{
  "job_token": "<wordpress-job-token>",
  "request_hash": "<wordpress-request-hash>",
  "request_id": "<wordpress-request-id>",
  "payload": {
    "model": "codex-local:image",
    "prompt": "A product-style image of a small desktop bridge icon",
    "size": "1024x1024",
    "quality": "high"
  }
}
```

Response:

```json
{
  "success": true,
  "response": {
    "data": [
      {
        "b64_json": "..."
      }
    ],
    "usage": {
      "total_tokens": 0,
      "local_unmetered": true
    },
    "provider_details": {
      "image_path": "<user-home>\\.codex\\generated_images\\...",
      "generated_images_dir": "<user-home>\\.codex\\generated_images"
    }
  }
}
```

The bridge returns exactly one detected generated image. If Codex completes without creating a new image under `CODEX_HOME/generated_images`, the bridge returns `success: false`.

When the installed Codex CLI supports `codex exec --json`, image and chat jobs use the structured event stream for cleaner progress and error details. If an older CLI rejects `--json`, the bridge reruns the job without structured events and preserves the legacy result shape.

## `POST /v1/videos`

Runs an optional OpenAI Videos API job. This route is disabled unless `ALORBACH_CODEX_ENABLE_VIDEO=1` and `ALORBACH_OPENAI_API_KEY` or `OPENAI_API_KEY` are configured. It is API-backed and not part of the user's local Codex allowance.

Request:

```json
{
  "job_token": "<wordpress-job-token>",
  "request_hash": "<wordpress-request-hash>",
  "request_id": "<wordpress-request-id>",
  "payload": {
    "action": "create",
    "model": "sora-2",
    "prompt": "A product teaser clip for a desktop bridge app.",
    "size": "1280x720",
    "seconds": "8",
    "poll": true,
    "download": false
  }
}
```

Supported `action` values are `create`, `retrieve`, `download`, `remix`, and `delete`. Create/remix responses may return queued or in-progress jobs unless `poll` is true. Downloads return base64 MP4 content in `response.b64_video` or `response.content.b64_video`.

## `POST /v1/media/analyze`

Analyzes bounded media frames through local Codex vision prompts. The safest input is a small array of image data URLs in `payload.frames`. The bridge can also download an HTTPS `media_url` and extract frames with `ffmpeg` when available. Local file paths, non-HTTPS URLs, localhost, and private-network URLs are rejected.

Request:

```json
{
  "job_token": "<wordpress-job-token>",
  "request_hash": "<wordpress-request-hash>",
  "request_id": "<wordpress-request-id>",
  "payload": {
    "model": "codex-local:auto",
    "prompt": "Summarize this video for accessibility alt text.",
    "frames": [
      "data:image/png;base64,..."
    ],
    "transcript": "Optional supplied audio transcript."
  }
}
```

For `media_url` analysis, `ffmpeg` must be available on PATH. Audio transcription is not performed locally; pass a transcript when audio content matters.

## Error Shape

Most errors use:

```json
{
  "success": false,
  "message": "Human-readable failure.",
  "details": {},
  "debug_help": {
    "request_id": "request-123",
    "route": "/v1/chat",
    "status_code": 500,
    "status_page": "http://127.0.0.1:8765/status",
    "status_json": "http://127.0.0.1:8765/v1/status",
    "checks": [
      "Open the status page and check Codex readiness plus recent failed jobs.",
      "Use the tray menu Copy diagnostics action for a safe diagnostic payload without bearer tokens."
    ]
  }
}
```

`debug_help` is intended for failed local bridge requests. It includes the request id when available, local status links, and safe troubleshooting steps. Running jobs and recent failed jobs in `GET /v1/status` can include bounded `session_output` when Codex stderr/stdout/last response text is available.

Common status codes:

- `400`: invalid JSON, oversized body, missing required fields, invalid origin, invalid payload.
- `403`: non-localhost socket, bad pairing code, missing or invalid pairing token.
- `404`: unknown route.
- `405`: unsupported method.
- `500`: Codex execution failed or unexpected bridge failure.
- `503`: status route reached the bridge, but Codex is not ready.
