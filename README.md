# Claude, Codex & Devin Limits

Monitor Claude Code, Codex, and Devin in separate VS Code status bar items. Claude and Codex keep their existing usage indicators; Devin adds a third item based on the documented v3 consumption API.

## Status bar

- **Claude:** 5-hour session, 7-day usage, and the optional 7-day Sonnet limit.
- **Codex:** current account-scoped OAuth rate limits first, then the local Codex app-server, with recent session logs as a display fallback. Model-specific windows are shown when the endpoint returns them.
- **Devin:** ACUs consumed over the trailing 7 days, when the local Devin API key can read the account’s organization consumption.
- **Refresh:** click any indicator to refresh all three.
- **Refresh interval:** five minutes.
- **Visibility:** each service supports `auto`, `always`, and `hidden`.

The current Devin v3 schema returns ACU consumption but does not expose the individual Max plan’s weekly quota percentage, reset timestamp, or on-demand credit balance. The Devin status item therefore shows the trailing 7-day ACU total and its tooltip states that those three values are unavailable; it does not infer a percentage or credit balance.

## Devin API access

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
| `claudeLimits.showProgressBars` | `true`, `false` | `true` | Show or hide Claude and Codex progress bars |

## Install the VSIX

1. Open Extensions in VS Code.
2. Select `…` → **Install from VSIX…**.
3. Choose `agent-limits.vsix`.

The package keeps the existing `maslovserg.claude-limits` extension ID so VS Code upgrades the installed extension and preserves its current settings.
