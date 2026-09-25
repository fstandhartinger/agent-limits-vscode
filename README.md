# Claude, Codex & Devin Limits

Monitor Claude Code, Codex, and Devin in separate VS Code status bar items. Claude and Codex keep their existing usage indicators; Devin adds a third item with the Max plan's weekly quota, read from the same endpoint as app.devin.ai's settings/usage page.

## Status bar

- **Claude:** 5-hour session, 7-day usage, and the optional 7-day Sonnet limit.
- **Codex:** current account-scoped OAuth rate limits first, then the local Codex app-server, with recent session logs as a display fallback. Model-specific windows are shown when the endpoint returns them.
- **Devin:** weekly quota % used and time to reset (plus the daily quota when Devin shows one). The tooltip adds on-demand credits, trailing 7-day organization ACUs and when Sandy last measured. If the quota summary is unreachable, it falls back to trailing 7-day ACUs from the v3 API key.
- **Refresh:** click any indicator to refresh all three.
- **Refresh interval:** five minutes.
- **Visibility:** each service supports `auto`, `always`, and `hidden`.

## Devin quota source

The public v3 API has no quota percentage. The app's settings/usage page calls `GET https://app.devin.ai/api/{org_id}/billing/quota/usage` with the web session's bearer token and `x-cog-org-id`. It returns `weekly_percentage`, `weekly_reset_at`, `daily_percentage`, `daily_reset_at`, `hide_daily_quota` and `overage_balance`.

The extension does not call it itself. On Sandy, `~/bin/devin-usage-log` (30-minute systemd timer) calls it and writes a secret-free summary to `~/.local/state/agent-limits/devin-latest.json`. The extension reads that file directly when it exists (VS Code on Sandy or Remote-SSH). Otherwise it runs `ssh -o BatchMode=yes <claudeLimits.devinSshHost> cat .local/state/agent-limits/devin-latest.json` (default host `sandy`). On Windows it also tries `wsl.exe -e ssh ...`. Readings older than 90 minutes get a warning icon.

## Devin API access (optional ACU fallback)

The extension reads the admin key from `~/.config/devin/api_key` on the VS Code extension host. In a WSL remote window, this means the Linux home directory in the WSL environment. The key is held in memory and sent only over HTTPS to `api.devin.ai`; it is not included in the VSIX, stored by the extension, or written to logs.

The extension calls `GET /v3/self` to find the organization ID, then `GET /v3/organizations/{org_id}/consumption/daily` for the trailing seven days. See the [Devin v3 OpenAPI schema](https://docs.devin.ai/v3-openapi.json). This key needs read access to those v3 endpoints.

## Existing Claude and Codex data

The Claude monitor reads the signed-in token locally, fetches usage, and stores the result in `~/.claude/limits.json`. It keeps the existing Stop hook and marks old readings as stale.

The Codex monitor reads the OAuth access token and account ID from `CODEX_HOME/auth.json` (or `~/.codex/auth.json`) and calls `GET https://chatgpt.com/backend-api/wham/usage`. It does not refresh or write that file. If the endpoint is unavailable, it falls back to `codex app-server` using `account/read` and `account/rateLimits/read`; recent local session logs remain the display fallback.

## Settings

Open VS Code Settings and search for **Agent Limits**.

| Setting | Options | Default | Description |
|---|---|---|---|
| `claudeLimits.language` | `ru`, `en` | `en` | Claude and Codex labels |
| `claudeLimits.claudeVisibility` | `auto`, `always`, `hidden` | `auto` | Claude indicator visibility |
| `claudeLimits.codexVisibility` | `auto`, `always`, `hidden` | `auto` | Codex indicator visibility |
| `claudeLimits.devinVisibility` | `auto`, `always`, `hidden` | `auto` | Devin indicator visibility |
| `claudeLimits.devinSshHost` | host name | `sandy` | SSH host that publishes the Devin quota summary; empty disables |
| `claudeLimits.showProgressBars` | `true`, `false` | `true` | Show or hide Claude and Codex progress bars |

## Install the VSIX

1. Open Extensions in VS Code.
2. Select `…` → **Install from VSIX…**.
3. Choose `agent-limits.vsix`.

The package keeps the existing `maslovserg.claude-limits` extension ID so VS Code upgrades the installed extension and preserves its current settings.
