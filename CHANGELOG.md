# Changelog

## [0.4.1]
- Codex now reads the account-scoped OAuth usage endpoint first, including provider reset timestamps, then falls back to the local Codex app-server and session logs.
- Shows model-specific Codex rate windows returned by the OAuth endpoint when available.
- The OAuth access token and account ID are read from `CODEX_HOME/auth.json` (or `~/.codex/auth.json`); this extension does not refresh or write those credentials.

## [0.4.0]
- Added a third Devin status item using the documented Devin v3 organization-consumption endpoints.
- Reads the local Devin API key from `~/.config/devin/api_key`; the key is sent only to `api.devin.ai` and is not stored or bundled.
- Reports trailing 7-day ACUs honestly. Devin's documented v3 API does not expose Max weekly quota percent, reset time, or on-demand credit balance, so those are not inferred.
- Preserved the existing Claude and Codex status items and carried forward the 0.3.4 Codex discovery, error, icon, startup, and progress-bar improvements.

## [0.3.4]
- Aligned service logo font metrics with VS Code icons.
- Suppressed startup warnings for 30 seconds and retry Codex after 10 and 20 seconds; persistent failures still show a warning.
- Added recognizable Claude and Codex logos before their status bar labels, including loading and error states.
- Icons are bundled as a small font and follow the status bar text color; progress bar visibility remains independent.


- Added the `claudeLimits.showProgressBars` checkbox (enabled by default). Turning it off hides bars for both services immediately, keeping percentages and reset times.
- Codex now discovers the executable bundled with the VS Code Codex extension; no separate desktop app or CLI installation is needed.
- Codex request failures keep the indicator visible with an error tooltip instead of silently hiding it. Previously fetched limits remain visible with a warning.

## [0.3.3]
- **Fixed Claude limits stuck at 0%** — Anthropic's edge started rejecting requests sent from Node.js with `403 Request not allowed`, so usage data could no longer be fetched; the extension and the Stop hook now use `curl` instead
- **No more silently stale numbers** — the indicator shows a warning icon when the data itself is out of date (not updated for more than two refresh intervals), and the tooltip explains why (for example `HTTP 429`) instead of quietly displaying old values as current. A failed refresh alone is not flagged while the Stop hook keeps the numbers current
- **Background refresh every 5 minutes** — the usage endpoint rate-limits frequent polling, so the previous 60-second interval was too aggressive
- **Background refresh skips redundant requests** — if the Stop hook already refreshed the data within the interval, the scheduled poll reuses it; clicking the indicator always forces a real request
- **Codex account is shown in the tooltip again** — the Codex app-server now returns `account: null`, so the signed-in name and email are read from the local `~/.codex/auth.json` instead
- **Stop hook no longer calls the API after every single response** — if `limits.json` was updated less than a minute ago, the hook exits without making a request, which keeps a busy session from running into `429`
- **Stop hook is rewritten only when its content changes** — local edits are no longer overwritten on every activation

## [0.3.2]
- **Claude + Codex monitoring** — added independent status bar indicators for both services, so each keeps its full usage text
- **Live Codex limits** — reads supported usage windows from the local Codex app-server, with recent local session logs as a fallback
- **Shared refresh** — clicking either indicator refreshes Claude and Codex together; background refresh runs every 60 seconds
- **Per-service visibility** — Claude and Codex each support Auto, Always, and Hidden modes
- **Login-aware defaults** — Auto mode shows only connected services and removes stale Codex data after logout
- **Localized tooltips** — concise click-to-refresh hints for both indicators; Claude also shows its active account
- **New marketplace icon and description** — updated branding for combined Claude and Codex monitoring

## [0.3.1]
- **Removed account switch button** — the button was calling `claude auth logout` globally, which logged out all active Claude Code sessions; removed entirely

## [0.3.0]
- **Account in tooltip** — hovering over the limits indicator shows the active account name and email, fetched live from `/api/oauth/profile`

## [0.2.9]
- **Account in tooltip** — hovering over the status bar now shows the active Claude account (name + email) below the refresh hint

## [0.2.8]
- **Language setting** — new `Claude Limits: Language` option (`ru` / `en`). English is the default: status bar shows `Session` / `Week`; switch to `ru` for Russian labels. Applies instantly without restarting VS Code
- Tooltip and refresh spinner text also respect the language setting
- One-time hint on first install: notifies the user that Russian labels are available, with an "Open Settings" button
- Fixed marketplace description: updated status bar format, added missing versions [0.2.6] and [0.1.9], corrected "How It Works" section

## [0.2.7]
- **Language setting** — new `Claude Limits: Language` option (`ru` / `en`). With `en`, the status bar shows `Session` and `Week` instead of Russian labels. Applies instantly without restarting VS Code
- Fixed marketplace description: updated status bar format, added missing versions [0.2.6] and [0.1.9], corrected "How It Works" section

## [0.2.6]
- **Compact Sonnet block** — displayed as `S: 🔴85%` with no progress bar; progress bar is shown only for Session and Week

## [0.2.5]
- Sonnet block hidden at 0% — appears only when actual usage accumulates
- Reset countdown removed from Sonnet block — it is already shown in the Week block

## [0.2.4]
- **Warning circles appear only when at risk** — below 60% the status bar is clean (bar + number only), 🟡 at 60–79%, 🔴 at 80%+; green circle removed
- README updated to match current format; Release Notes section removed (history is now in CHANGELOG only)

## [0.2.3]
- Circles replaced with 🟡 / 🔴 and moved right next to the percentage number

## [0.2.2]
- All three indicators merged into a **single status bar item** — other extensions can no longer split the group

## [0.2.1]
- Added **third indicator** — weekly Sonnet-only limit (Max plan). Appears automatically when the API returns the `seven_day_sonnet` field

## [0.2.0]
- **Fixed zero display** — removed the logic that reset usage to 0% when `resets_at` was in the past; the real API value is always shown now

## [0.1.9]
- **Background API polling** — extension calls the Anthropic API directly every 60 seconds, independent of the hook
- Spinner shown only on manual click; background refresh is silent

## [0.1.8]
- **Fixed click-refresh** — extension now makes the HTTP request directly (no bash), spinner is visible during the actual API wait

## [0.1.7]
- **Click to refresh** — clicking the status bar item triggers a live API request and shows a spinner while loading

## [0.1.6]
- Version bump to republish with updated release notes

## [0.1.5]
- **Auto-setup on install** — extension automatically creates `~/.claude/hooks/save-limits.sh` and registers the Stop hook in `~/.claude/settings.json`; no manual configuration needed
- **No `jq` dependency** — hook script rewritten to use only Node.js (works on Windows, macOS, Linux)

## [0.1.4]
- Switched to `icon.png`
- Version bump

## [0.1.3]
- Auto-reset: usage drops to 0% when `resets_at` timestamp is in the past
- Added 60-second periodic refresh timer (status updates even when file is unchanged)

## [0.1.2]
- Split status bar into two separate items (session / weekly)
- Added reset countdown display

## [0.1.1]
- Added color alerts (green / yellow / red)
- Progress bar visualization

## [0.1.0]
- Initial release
