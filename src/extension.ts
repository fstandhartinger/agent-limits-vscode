import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';
import { parseLimits, formatStatusText, parseCodexLimitsFromSessionLog, parseCodexLimitsFromWhamUsage, parseCodexLimitsFromAppServerRateLimits, parseCodexAccountLabel, formatCodexStatusText, shouldShowService, CodexLimitsData, VisibilityMode, Lang } from './limits';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const LIMITS_FILE = path.join(CLAUDE_DIR, 'limits.json');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const HOOK_SCRIPT = path.join(HOOKS_DIR, 'save-limits.sh');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CREDS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const CODEX_HOME_DIR = process.env.CODEX_HOME?.trim()
  ? path.resolve(process.env.CODEX_HOME.trim())
  : path.join(os.homedir(), '.codex');
const CODEX_AUTH_FILE = path.join(CODEX_HOME_DIR, 'auth.json');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'sessions');
const DEVIN_API_KEY_FILE = path.join(os.homedir(), '.config', 'devin', 'api_key');
// Пять минут вместо минуты: эндпоинт лимитов не публичный и при частых запросах отвечает 429.
const REFRESH_INTERVAL_MS = 300_000;
const DEVIN_REFRESH_INTERVAL_MS = 300_000;

interface DevinUsageData {
  trailing7dAcus: number;
}

interface DevinApiResult {
  status: number;
  body: string;
}

function requestDevinApi(pathname: string, apiKey: string): Promise<DevinApiResult> {
  return new Promise(resolve => {
    let settled = false;
    let body = '';
    const finish = (status: number, responseBody: string) => {
      if (settled) return;
      settled = true;
      resolve({ status, body: responseBody });
    };
    const request = https.get(`https://api.devin.ai${pathname}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: 15_000,
    }, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => finish(response.statusCode || 0, body));
      response.on('error', () => finish(0, ''));
    });
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', () => finish(0, ''));
  });
}

async function fetchDevinUsage(): Promise<DevinUsageData> {
  const apiKey = fs.readFileSync(DEVIN_API_KEY_FILE, 'utf8').trim();
  if (!apiKey) throw new Error('empty API key file');

  const selfResponse = await requestDevinApi('/v3/self', apiKey);
  if (selfResponse.status !== 200) throw new Error(`HTTP ${selfResponse.status || 'network error'} from /v3/self`);
  const self = JSON.parse(selfResponse.body) as { org_id?: unknown };
  if (typeof self?.org_id !== 'string' || !self.org_id) throw new Error('v3/self omitted org_id');

  const now = Math.floor(Date.now() / 1000);
  const after = now - 7 * 24 * 60 * 60;
  const consumptionPath = `/v3/organizations/${encodeURIComponent(self.org_id)}/consumption/daily?time_after=${after}&time_before=${now}`;
  const usageResponse = await requestDevinApi(consumptionPath, apiKey);
  if (usageResponse.status !== 200) throw new Error(`HTTP ${usageResponse.status || 'network error'} from consumption API`);
  const usage = JSON.parse(usageResponse.body) as { total_acus?: unknown };
  if (typeof usage?.total_acus !== 'number' || !Number.isFinite(usage.total_acus)) {
    throw new Error('consumption response omitted total_acus');
  }
  return { trailing7dAcus: usage.total_acus };
}

function findLatestCodexSessionFiles(dir: string, limit = 20): string[] {
  const files: { file: string; mtimeMs: number }[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          files.push({ file: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch {}
      }
    }
  }

  walk(dir);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(item => item.file);
}

function readLatestCodexLimits() {
  for (const file of findLatestCodexSessionFiles(CODEX_SESSIONS_DIR)) {
    try {
      const limits = parseCodexLimitsFromSessionLog(fs.readFileSync(file, 'utf8'));
      if (limits) return limits;
    } catch {}
  }
  return null;
}

function fetchCodexLimits(onAccountLabel: (label: string) => void, onError: (error: string) => void): Promise<CodexLimitsData | null> {
  return fetchCodexLimitsFromOAuth().then(oauth => {
    if (oauth.limits) {
      if (oauth.accountLabel) onAccountLabel(oauth.accountLabel);
      onError('');
      return oauth.limits;
    }

    let appServerError = '';
    return fetchCodexLimitsFromAppServer(onAccountLabel, error => { appServerError = error; }).then(limits => {
      onError(limits ? '' : [oauth.error, appServerError].filter(Boolean).join('; '));
      return limits;
    });
  });
}

interface CodexOAuthCredentials {
  accessToken: string;
  accountId?: string;
  accountLabel: string;
}

interface CodexOAuthFetchResult {
  limits: CodexLimitsData | null;
  accountLabel: string;
  error: string;
}

function readCodexOAuthCredentials(): CodexOAuthCredentials | null {
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8'));
    const tokens = auth?.tokens;
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token) return null;
    return {
      accessToken: tokens.access_token,
      accountId: typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id : undefined,
      accountLabel: parseCodexAccountLabel(tokens.id_token),
    };
  } catch {
    return null;
  }
}

function fetchCodexLimitsFromOAuth(): Promise<CodexOAuthFetchResult> {
  const credentials = readCodexOAuthCredentials();
  if (!credentials) return Promise.resolve({ limits: null, accountLabel: '', error: 'OAuth credentials unavailable' });

  return new Promise(resolve => {
    let settled = false;
    let body = '';
    const finish = (limits: CodexLimitsData | null, error = '') => {
      if (settled) return;
      settled = true;
      resolve({ limits, accountLabel: credentials.accountLabel, error });
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Agent-Limits-VSCode',
    };
    if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId;

    const request = https.get('https://chatgpt.com/backend-api/wham/usage', { headers, timeout: 15_000 }, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy(new Error('response too large'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish(null, `OAuth API HTTP ${response.statusCode || 'error'}`);
          return;
        }
        const limits = parseCodexLimitsFromWhamUsage(body);
        finish(limits, limits ? '' : 'OAuth API returned no rate windows');
      });
      response.on('error', () => finish(null, 'OAuth API response error'));
    });
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', () => finish(null, 'OAuth API network error'));
  });
}

// Fallback account identity: app-server may omit it even though the auth file has an id token.
function readCodexAccountLabel(): string {
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8'));
    return parseCodexAccountLabel(auth?.tokens?.id_token);
  } catch {
    return '';
  }
}

function findCodexExecutable(): string | null {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (extension) {
    const platformDir = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const bundled = path.join(extension.extensionPath, 'bin', platformDir + '-' + architecture, binary);
    if (fs.existsSync(bundled)) return bundled;
  }

  const desktopBin = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  try {
    const versions = fs.readdirSync(desktopBin, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(desktopBin, entry.name, 'codex.exe'))
      .filter(file => fs.existsSync(file));
    if (versions.length > 0) return versions[versions.length - 1];
  } catch {}

  // Spawn a native binary; Windows .cmd launchers require a shell.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const base = dir.replace(/^"|"$/g, '');
    const binary = path.join(base, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(binary)) return binary;
    if (process.platform === 'win32') {
      const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const vendor = path.join(base, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
        process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64', 'vendor',
        architecture + '-pc-windows-msvc', 'codex', 'codex.exe');
      if (fs.existsSync(vendor)) return vendor;
    }
  }
  return process.platform === 'win32' ? null : 'codex';
}

function fetchCodexLimitsFromAppServer(onAccountLabel: (label: string) => void, onError: (error: string) => void): Promise<CodexLimitsData | null> {
  return new Promise(resolve => {
    const executable = findCodexExecutable();
    if (!executable) {
      onError('CLI not found');
      resolve(null);
      return;
    }

    let settled = false;
    let buffer = '';
    const child = spawn(executable, ['app-server'], {
      env: { ...process.env, CODEX_HOME: CODEX_HOME_DIR },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });

    function finish(limits: CodexLimitsData | null, error = ''): void {
      if (settled) return;
      settled = true;
      onError(error);
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(limits);
    }

    function send(message: unknown): void {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch {
        finish(null, 'CLI input failed');
      }
    }

    const timer = setTimeout(() => finish(null, 'Request timed out'), 10_000);

    child.on('error', error => finish(null, 'CLI: ' + ((error as NodeJS.ErrnoException).code || 'start failed')));
    child.on('close', () => finish(null, 'CLI exited before returning limits'));
    child.stdin.on('error', error => finish(null, 'CLI input: ' + ((error as NodeJS.ErrnoException).code || 'failed')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.error && [1, 2, 3].includes(message.id)) {
            finish(null, 'RPC error ' + message.error.code);
            continue;
          }
          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ method: 'account/read', id: 2, params: { refreshToken: true } });
          } else if (message.id === 2) {
            const account = message.result?.account ?? message.result;
            const email = typeof account?.email === 'string' ? account.email : '';
            const name = typeof account?.displayName === 'string'
              ? account.displayName
              : typeof account?.name === 'string'
                ? account.name
                : '';
            onAccountLabel(name && email ? `${name} (${email})` : email || name);
            send({ method: 'account/rateLimits/read', id: 3 });
          } else if (message.id === 3) {
            const limits = parseCodexLimitsFromAppServerRateLimits(message.result?.rateLimits);
            finish(limits, limits ? '' : 'No rate limits in response');
          }
        } catch {}
      }
    });

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'agent-limits-vscode', title: 'Agent Limits VS Code', version: '0.4.0' },
      },
    });
  });
}

// Запросы к api.anthropic.com идут через curl: обращения из node блокирует Cloudflare (403 "Request not allowed").
function curlGet(urlPath: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    let settled = false;
    let out = '';
    function finish(status: number, body: string): void {
      if (settled) return;
      settled = true;
      resolve({ status, body });
    }
    try {
      const child = spawn('curl', [
        '-s', '--max-time', '10',
        '-w', '\n%{http_code}',
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'anthropic-beta: oauth-2025-04-20',
        `https://api.anthropic.com${urlPath}`,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('error', () => finish(0, ''));
      child.on('close', () => {
        const cut = out.lastIndexOf('\n');
        if (cut < 0) { finish(0, ''); return; }
        finish(Number(out.slice(cut + 1).trim()) || 0, out.slice(0, cut));
      });
    } catch { finish(0, ''); }
  });
}

function readToken(): string {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    return typeof token === 'string' ? token : '';
  } catch {
    return '';
  }
}

function fetchAccountLabel(): Promise<string> {
  const token = readToken();
  if (!token) return Promise.resolve('');
  return curlGet('/api/oauth/profile', token).then(({ status, body }) => {
    if (status !== 200) return '';
    try {
      const acc = JSON.parse(body)?.account;
      if (!acc) return '';
      return (acc.display_name ? `${acc.display_name} (${acc.email})` : acc.email) || '';
    } catch { return ''; }
  });
}

const HOOK_CONTENT = `#!/usr/bin/env bash
# Claude Limits Monitor: fetches rate limits after each response
# Запрос делает curl: обращения из node к api.anthropic.com блокирует Cloudflare (403 "Request not allowed").
CREDS="$HOME/.claude/.credentials.json"
LIMITS="$HOME/.claude/limits.json"
[ -f "$CREDS" ] || exit 0
# Хук срабатывает после каждого ответа: если лимиты обновлялись меньше минуты назад, запрос не нужен.
if [ -f "$LIMITS" ] && [ -z "$(find "$LIMITS" -mmin +1 2>/dev/null)" ]; then exit 0; fi
TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(c.claudeAiOauth?.accessToken||'')}catch(e){}" "$CREDS")
[ -n "$TOKEN" ] || exit 0

curl -s --max-time 10 \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "anthropic-beta: oauth-2025-04-20" \\
  https://api.anthropic.com/api/oauth/usage | node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');

let data = '';
process.stdin.on('data', c => data += c);
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(data);
    if (d.error) return;
    if (typeof d.five_hour?.utilization !== 'number' || typeof d.seven_day?.utilization !== 'number') return;
    const out = {
      five_hour: { used_percentage: d.five_hour.utilization, resets_at: d.five_hour.resets_at || null },
      seven_day: { used_percentage: d.seven_day.utilization, resets_at: d.seven_day.resets_at || null }
    };
    if (typeof d.seven_day_sonnet?.utilization === 'number') {
      out.seven_day_sonnet = { used_percentage: d.seven_day_sonnet.utilization, resets_at: d.seven_day_sonnet.resets_at || null };
    }
    fs.writeFileSync(path.join(os.homedir(), '.claude', 'limits.json'), JSON.stringify(out));
  } catch(e) {}
});
"
`;

function ensureHookSetup(): boolean {
  try {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    let currentHook = '';
    try { currentHook = fs.readFileSync(HOOK_SCRIPT, 'utf8'); } catch {}
    if (currentHook !== HOOK_CONTENT) {
      fs.writeFileSync(HOOK_SCRIPT, HOOK_CONTENT, { mode: 0o755 });
    }

    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}

    const hookCmd = `bash "${HOOK_SCRIPT.replace(/\\/g, '/')}"`;

    const stopGroups: unknown[] = (settings.hooks as Record<string, unknown>)?.Stop as unknown[] ?? [];
    const alreadySet = stopGroups.some((g: unknown) =>
      (g as { hooks?: { command?: string }[] })?.hooks?.some(h => h?.command?.includes('save-limits.sh'))
    );
    if (alreadySet) return false;

    if (!settings.hooks) { settings.hooks = {}; }
    const hooks = settings.hooks as Record<string, unknown[]>;
    if (!hooks.Stop) { hooks.Stop = []; }
    hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: hookCmd }] });

    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  ensureHookSetup();

  if (!context.globalState.get('languageHintShown')) {
    context.globalState.update('languageHintShown', true);
    vscode.window.showInformationMessage(
      'Claude Limits: status bar is in English by default. Switch to Russian in Settings → claudeLimits.language = ru',
      'Open Settings'
    ).then(choice => {
      if (choice === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:maslovserg.claude-limits');
      }
    });
  }

  const claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  const codexItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const devinItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  claudeItem.command = 'claudeLimits.refresh';
  codexItem.command = 'claudeLimits.refresh';
  devinItem.command = 'claudeLimits.refresh';
  context.subscriptions.push(claudeItem, codexItem, devinItem);

  const STRINGS: Record<Lang, { tooltip: string; updating: string; codexTooltip: string; staleData: string; noData: string }> = {
    ru: {
      tooltip: 'Claude Limits — клик для обновления',
      updating: '$(sync~spin) Claude Limits: обновление...',
      codexTooltip: 'Codex Limit: клик для обновления',
      staleData: 'Не удалось обновить лимиты — показаны последние известные данные',
      noData: 'Не удалось получить лимиты',
    },
    en: {
      tooltip: 'Claude Limits — click to refresh',
      updating: '$(sync~spin) Claude Limits: updating...',
      codexTooltip: 'Codex Limit: click to refresh',
      staleData: 'Could not refresh limits — showing last known data',
      noData: 'Could not fetch limits',
    },
  };

  let cachedAccountLabel = '';
  let cachedCodexAccountLabel = '';
  let cachedCodexLimits: CodexLimitsData | null = null;
  let codexConnected = false;
  let codexDetected = false;
  let codexFetchError = '';
  let claudeFetchError = '';
  let dataIsStale = false;
  let startupGrace = true;
  let devinConnected = fs.existsSync(DEVIN_API_KEY_FILE);
  let devinFetchError = '';
  let cachedDevinUsage: DevinUsageData | null = null;
  let devinFetchedAt = 0;

  function dataAgeMs(): number {
    try {
      return Date.now() - fs.statSync(LIMITS_FILE).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  // Лимиты считаются несвежими, если файл не обновлялся дольше двух интервалов опроса.
  function isDataStale(): boolean {
    return dataAgeMs() > 2 * REFRESH_INTERVAL_MS;
  }

  function applyTooltips(lang: Lang): void {
    const claudeLines = [STRINGS[lang].tooltip];
    if (cachedAccountLabel) claudeLines.push(cachedAccountLabel);
    if (dataIsStale && !startupGrace) {
      claudeLines.push(claudeFetchError
        ? `⚠ ${STRINGS[lang].staleData} (${claudeFetchError})`
        : `⚠ ${STRINGS[lang].staleData}`);
    }
    claudeItem.tooltip = claudeLines.join('\n');
    codexItem.tooltip = cachedCodexAccountLabel
      ? `${STRINGS[lang].codexTooltip}\n${cachedCodexAccountLabel}`
      : STRINGS[lang].codexTooltip;
    if (codexFetchError && !startupGrace) {
      codexItem.tooltip += `\n⚠ ${STRINGS[lang].noData}: ${codexFetchError}`;
    }
    const devinTooltip = [
      'Devin v3 API — click to refresh',
      cachedDevinUsage
        ? `Trailing 7-day consumption: ${cachedDevinUsage.trailing7dAcus.toFixed(2)} ACUs`
        : 'Trailing 7-day ACU consumption is unavailable',
      'The documented v3 API does not expose Max weekly quota percent, reset time, or on-demand credit balance.',
    ];
    if (devinFetchError && !startupGrace) devinTooltip.push(`⚠ ${devinFetchError}`);
    if (devinFetchedAt) devinTooltip.push(`Last update: ${new Date(devinFetchedAt).toLocaleTimeString()}`);
    devinItem.tooltip = devinTooltip.join('\n');
  }

  function getLang(): Lang {
    return vscode.workspace.getConfiguration('claudeLimits').get<Lang>('language', 'en');
  }

  function getVisibility(key: 'claudeVisibility' | 'codexVisibility' | 'devinVisibility'): VisibilityMode {
    return vscode.workspace.getConfiguration('claudeLimits').get<VisibilityMode>(key, 'auto');
  }

  function isClaudeConnected(): boolean {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      return typeof creds?.claudeAiOauth?.accessToken === 'string' && creds.claudeAiOauth.accessToken.length > 0;
    } catch {
      return false;
    }
  }

  function refresh() {
    const lang = getLang();
    const showProgressBars = vscode.workspace.getConfiguration('claudeLimits').get<boolean>('showProgressBars', true);
    // Данные пишут двое: сам опрос и Stop-хук. Поэтому «несвежесть» определяется возрастом файла,
    // а не судьбой последнего запроса: пока хук обновляет лимиты, неудачный опрос не повод пугать.
    dataIsStale = isDataStale();
    applyTooltips(lang);
    let claudeText: string;
    try {
      const content = fs.readFileSync(LIMITS_FILE, 'utf8');
      const limits = parseLimits(content);
      if (limits) {
        claudeText = dataIsStale && !startupGrace
          ? `$(warning) ${formatStatusText(limits, lang, showProgressBars)}`
          : formatStatusText(limits, lang, showProgressBars);
      } else {
        claudeText = startupGrace ? 'Claude: updating...' : 'Claude: N/A';
      }
    } catch {
      claudeText = startupGrace ? 'Claude: updating...' : `$(warning) Claude: ${STRINGS[lang].noData}`;
    }

    const codexLimits = cachedCodexLimits ?? readLatestCodexLimits();
    const codexText = codexLimits
      ? `${codexFetchError && !startupGrace ? '$(warning) ' : ''}${formatCodexStatusText(codexLimits, lang, showProgressBars)}`
      : startupGrace ? 'Codex: updating...' : `$(warning) Codex: ${STRINGS[lang].noData}`;
    const devinText = cachedDevinUsage
      ? `${devinFetchError && !startupGrace ? '$(warning) ' : ''}Devin: 7d ${cachedDevinUsage.trailing7dAcus.toFixed(2)} ACU`
      : startupGrace ? 'Devin: updating...' : `$(warning) Devin: ${devinFetchError || 'quota data unavailable'}`;
    claudeItem.text = '$(claude-limits-claude) ' + claudeText;
    codexItem.text = '$(claude-limits-codex) ' + codexText;
    devinItem.text = devinText;
    if (shouldShowService(getVisibility('claudeVisibility'), isClaudeConnected())) {
      claudeItem.show();
    } else {
      claudeItem.hide();
    }
    if (shouldShowService(getVisibility('codexVisibility'), codexConnected || codexDetected)) {
      codexItem.show();
    } else {
      codexItem.hide();
    }
    if (shouldShowService(getVisibility('devinVisibility'), devinConnected)) {
      devinItem.show();
    } else {
      devinItem.hide();
    }
  }

  function fetchCodexAndRefresh() {
    codexDetected = Boolean(vscode.extensions.getExtension('openai.chatgpt')) || fs.existsSync(CODEX_AUTH_FILE);
    fetchCodexLimits(label => {
      cachedCodexAccountLabel = label || readCodexAccountLabel();
      applyTooltips(getLang());
    }, error => { codexFetchError = error; }).then(limits => {
      if (!cachedCodexAccountLabel) cachedCodexAccountLabel = readCodexAccountLabel();
      if (limits) cachedCodexLimits = limits;
      codexConnected = Boolean(limits || cachedCodexAccountLabel);
      refresh();
    });
  }

  function fetchDevinAndRefresh(manualRefresh = false) {
    devinConnected = fs.existsSync(DEVIN_API_KEY_FILE);
    if (!devinConnected) {
      devinFetchError = 'no ~/.config/devin/api_key file';
      refresh();
      return;
    }
    if (!manualRefresh && Date.now() - devinFetchedAt < DEVIN_REFRESH_INTERVAL_MS) {
      refresh();
      return;
    }
    devinFetchedAt = Date.now();
    fetchDevinUsage().then(usage => {
      cachedDevinUsage = usage;
      devinFetchError = '';
    }).catch(error => {
      devinFetchError = error instanceof Error ? error.message : 'request failed';
    }).finally(refresh);
  }

  function fetchAndRefresh(manualRefresh = false) {
    if (manualRefresh) {
      claudeItem.text = '$(claude-limits-claude) ' + STRINGS[getLang()].updating;
      codexItem.text = '$(claude-limits-codex) $(sync~spin) Codex: updating...';
      devinItem.text = '$(sync~spin) Devin: updating...';
      if (shouldShowService(getVisibility('claudeVisibility'), isClaudeConnected())) claudeItem.show();
      if (shouldShowService(getVisibility('codexVisibility'), codexConnected || codexDetected)) codexItem.show();
      if (shouldShowService(getVisibility('devinVisibility'), fs.existsSync(DEVIN_API_KEY_FILE))) devinItem.show();
    }

    fetchAccountLabel().then(label => {
      cachedAccountLabel = label;
      applyTooltips(getLang());
    });

    fetchCodexAndRefresh();
    fetchDevinAndRefresh(manualRefresh);

    const token = readToken();
    if (!token) { claudeFetchError = 'no credentials'; refresh(); return; }

    // Данные мог только что записать Stop-хук — тогда фоновый опрос не тратит лишний запрос.
    // Клик по индикатору обновляет всегда: пользователь попросил явно.
    if (!manualRefresh && dataAgeMs() < REFRESH_INTERVAL_MS) {
      claudeFetchError = '';
      refresh();
      return;
    }

    curlGet('/api/oauth/usage', token).then(({ status, body }) => {
      if (status !== 200) {
        claudeFetchError = status ? `HTTP ${status}` : 'network error';
        refresh();
        return;
      }
      try {
        const d = JSON.parse(body);
        if (!d.error &&
            typeof d.five_hour?.utilization === 'number' && typeof d.seven_day?.utilization === 'number') {
          const out: Record<string, unknown> = {
            five_hour: { used_percentage: d.five_hour.utilization, resets_at: d.five_hour.resets_at || null },
            seven_day: { used_percentage: d.seven_day.utilization, resets_at: d.seven_day.resets_at || null }
          };
          if (typeof d.seven_day_sonnet?.utilization === 'number') {
            out.seven_day_sonnet = { used_percentage: d.seven_day_sonnet.utilization, resets_at: d.seven_day_sonnet.resets_at || null };
          }
          fs.writeFileSync(LIMITS_FILE, JSON.stringify(out));
          claudeFetchError = '';
        } else {
          claudeFetchError = 'unexpected response';
        }
      } catch {
        claudeFetchError = 'bad response';
      }
      refresh();
    });
  }

  context.subscriptions.push(vscode.commands.registerCommand('claudeLimits.refresh', () => fetchAndRefresh(true)));

  fs.watchFile(LIMITS_FILE, { interval: 1000 }, refresh);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(LIMITS_FILE) });

  const timer = setInterval(fetchAndRefresh, REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (
      e.affectsConfiguration('claudeLimits.showProgressBars') ||
      e.affectsConfiguration('claudeLimits.language') ||
      e.affectsConfiguration('claudeLimits.claudeVisibility') ||
      e.affectsConfiguration('claudeLimits.codexVisibility') ||
      e.affectsConfiguration('claudeLimits.devinVisibility')
    ) {
      refresh();
    }
  }));

  fetchAndRefresh();
  const startupTimers = [10_000, 20_000].map(delay => setTimeout(() => {
    if (codexFetchError) fetchCodexAndRefresh();
  }, delay));
  startupTimers.push(setTimeout(() => {
    startupGrace = false;
    refresh();
  }, 30_000));
  context.subscriptions.push({ dispose: () => startupTimers.forEach(clearTimeout) });
}

export function deactivate() {}
