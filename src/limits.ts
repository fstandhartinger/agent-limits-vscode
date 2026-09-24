export interface LimitsData {
  fiveHour: number;
  sevenDay: number;
  sevenDaySonnet?: number;
  fiveHourResetsAt?: string;
  sevenDayResetsAt?: string;
  sevenDaySonnetResetsAt?: string;
}

export interface CodexLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: string;
  label?: string;
}

export interface CodexLimitsData {
  primary?: CodexLimitWindow;
  secondary?: CodexLimitWindow;
  individual?: CodexLimitWindow;
  planType?: string;
}

export type VisibilityMode = 'auto' | 'always' | 'hidden';

export function shouldShowService(mode: VisibilityMode, connected: boolean): boolean {
  if (mode === 'hidden') return false;
  if (mode === 'always') return true;
  return connected;
}

const BAR_WIDTH = 6;

export function parseLimits(jsonStr: string): LimitsData | null {
  try {
    const data = JSON.parse(jsonStr);
    let fh = data?.five_hour?.used_percentage;
    let sd = data?.seven_day?.used_percentage;
    if (typeof fh !== 'number' || typeof sd !== 'number') return null;
    const fhResetsAt: string | undefined = data.five_hour?.resets_at;
    const sdResetsAt: string | undefined = data.seven_day?.resets_at;
    const sdsPct = data?.seven_day_sonnet?.used_percentage;
    const sdsResetsAt: string | undefined = data?.seven_day_sonnet?.resets_at;
    const now = Date.now();
    return {
      fiveHour: fh,
      sevenDay: sd,
      sevenDaySonnet: typeof sdsPct === 'number' && sdsPct > 0 ? sdsPct : undefined,
      fiveHourResetsAt: fhResetsAt && new Date(fhResetsAt).getTime() > now ? fhResetsAt : undefined,
      sevenDayResetsAt: sdResetsAt && new Date(sdResetsAt).getTime() > now ? sdResetsAt : undefined,
      sevenDaySonnetResetsAt: sdsResetsAt && new Date(sdsResetsAt).getTime() > now ? sdsResetsAt : undefined,
    };
  } catch {
    return null;
  }
}

export function formatProgressBar(pct: number): string {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

export function getColor(pct: number): 'green' | 'yellow' | 'red' {
  if (pct >= 80) return 'red';
  if (pct >= 50) return 'yellow';
  return 'green';
}

export function getStatusEmoji(pct: number): string {
  if (pct >= 80) return '🔴';
  if (pct >= 60) return '🟡';
  return '';
}

export function formatTimeRemaining(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export type Lang = 'ru' | 'en';

const LABELS: Record<Lang, { session: string; week: string }> = {
  ru: { session: 'Сессия', week: 'Неделя' },
  en: { session: 'Session', week: 'Week' },
};

export function formatFiveHourText(limits: LimitsData, lang: Lang = 'en', showProgressBars = true): string {
  const bar = showProgressBars ? formatProgressBar(limits.fiveHour) + ' ' : '';
  const emoji = getStatusEmoji(limits.fiveHour);
  const time = limits.fiveHourResetsAt ? ` (~${formatTimeRemaining(limits.fiveHourResetsAt)})` : '';
  return `${LABELS[lang].session}: ${bar}${emoji}${limits.fiveHour}%${time}`;
}

export function formatSevenDayText(limits: LimitsData, lang: Lang = 'en', showProgressBars = true): string {
  const bar = showProgressBars ? formatProgressBar(limits.sevenDay) + ' ' : '';
  const emoji = getStatusEmoji(limits.sevenDay);
  const time = limits.sevenDayResetsAt ? ` (~${formatTimeRemaining(limits.sevenDayResetsAt)})` : '';
  return `${LABELS[lang].week}: ${bar}${emoji}${limits.sevenDay}%${time}`;
}

export function formatSevenDaySonnetText(limits: LimitsData): string | null {
  if (typeof limits.sevenDaySonnet !== 'number') return null;
  const emoji = getStatusEmoji(limits.sevenDaySonnet);
  return `S: ${emoji}${limits.sevenDaySonnet}%`;
}

export function formatStatusText(limits: LimitsData, lang: Lang = 'en', showProgressBars = true): string {
  const base = `${formatFiveHourText(limits, lang, showProgressBars)} | ${formatSevenDayText(limits, lang, showProgressBars)}`;
  const sonnet = formatSevenDaySonnetText(limits);
  if (!sonnet) return `Claude: ${base}`;
  return `Claude: ${base} | ${sonnet}`;
}

function parseCodexReset(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function parseCodexWindow(data: unknown, label?: string): CodexLimitWindow | undefined {
  const window = data as {
    used_percent?: unknown;
    usedPercent?: unknown;
    window_minutes?: unknown;
    windowDurationMins?: unknown;
    limit_window_seconds?: unknown;
    resets_at?: unknown;
    resetsAt?: unknown;
    reset_at?: unknown;
  } | null;
  const windowMinutes = typeof window?.window_minutes === 'number'
    ? window.window_minutes
    : typeof window?.windowDurationMins === 'number'
      ? window.windowDurationMins
    : typeof window?.limit_window_seconds === 'number'
      ? Math.round(window.limit_window_seconds / 60)
      : undefined;
  const usedPercent = typeof window?.used_percent === 'number'
    ? window.used_percent
    : typeof window?.usedPercent === 'number'
      ? window.usedPercent
      : undefined;
  if (typeof usedPercent !== 'number' || typeof windowMinutes !== 'number') return undefined;
  const resetsAt = parseCodexReset(window?.resets_at ?? window?.reset_at ?? window?.resetsAt);
  return {
    usedPercent: Math.round(usedPercent),
    windowMinutes,
    resetsAt: resetsAt && new Date(resetsAt).getTime() > Date.now() ? resetsAt : undefined,
    label,
  };
}

export function parseCodexLimitsFromJsonLine(line: string): CodexLimitsData | null {
  try {
    const data = JSON.parse(line);
    const rateLimits = data?.payload?.rate_limits;
    if (!rateLimits) return null;
    const primary = parseCodexWindow(rateLimits.primary);
    const secondary = parseCodexWindow(rateLimits.secondary);
    const individual = parseCodexWindow(rateLimits.individual_limit, 'I');
    if (!primary && !secondary && !individual) return null;
    return {
      primary,
      secondary,
      individual,
      planType: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : undefined,
    };
  } catch {
    return null;
  }
}

export function parseCodexLimitsFromSessionLog(content: string): CodexLimitsData | null {
  let latest: CodexLimitsData | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('"rate_limits"')) continue;
    const limits = parseCodexLimitsFromJsonLine(line);
    if (limits) latest = limits;
  }
  return latest;
}

export function parseCodexLimitsFromWhamUsage(jsonStr: string): CodexLimitsData | null {
  try {
    const data = JSON.parse(jsonStr);
    const rateLimit = data?.rate_limit ?? data?.rateLimit;
    if (!rateLimit) return null;
    const primary = parseCodexWindow(rateLimit.primary_window ?? rateLimit.primaryWindow);
    const secondary = parseCodexWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow);
    const individual = parseCodexWindow(rateLimit.individual_limit ?? rateLimit.individualLimit, 'I');
    if (!primary && !secondary && !individual) return null;
    return {
      primary,
      secondary,
      individual,
      planType: typeof data?.plan_type === 'string' ? data.plan_type : undefined,
    };
  } catch {
    return null;
  }
}

export function parseCodexLimitsFromAppServerRateLimits(rateLimits: unknown): CodexLimitsData | null {
  const data = rateLimits as { primary?: unknown; secondary?: unknown; individualLimit?: unknown; planType?: unknown } | null;
  const primary = parseCodexWindow(data?.primary);
  const secondary = parseCodexWindow(data?.secondary);
  const individual = parseCodexWindow(data?.individualLimit, 'I');
  if (!primary && !secondary && !individual) return null;
  return {
    primary,
    secondary,
    individual,
    planType: typeof data?.planType === 'string' ? data.planType : undefined,
  };
}

function getCodexWindowLabel(windowMinutes: number, lang: Lang): string {
  if (windowMinutes >= 10080) return LABELS[lang].week;
  if (windowMinutes <= 300) return LABELS[lang].session;
  const hours = Math.round(windowMinutes / 60);
  return hours >= 1 ? `${hours}h` : `${windowMinutes}m`;
}

export function formatCodexWindowText(window: CodexLimitWindow, lang: Lang = 'en', showProgressBars = true): string {
  if (window.label) {
    const emoji = getStatusEmoji(window.usedPercent);
    return `${window.label}: ${emoji}${window.usedPercent}%`;
  }

  const bar = showProgressBars ? formatProgressBar(window.usedPercent) + ' ' : '';
  const emoji = getStatusEmoji(window.usedPercent);
  const time = window.resetsAt ? ` (~${formatTimeRemaining(window.resetsAt)})` : '';
  return `${getCodexWindowLabel(window.windowMinutes, lang)}: ${bar}${emoji}${window.usedPercent}%${time}`;
}

export function formatCodexStatusText(limits: CodexLimitsData, lang: Lang = 'en', showProgressBars = true): string {
  const blocks = [limits.secondary, limits.primary, limits.individual]
    .filter((window): window is CodexLimitWindow => Boolean(window))
    .sort((a, b) => a.windowMinutes - b.windowMinutes)
    .map(window => formatCodexWindowText(window, lang, showProgressBars));
  return blocks.length > 0 ? `Codex: ${blocks.join(' | ')}` : 'Codex Limits: N/A';
}

// Codex-аккаунт: app-server может вернуть account: null, тогда имя и почту берём из id_token в ~/.codex/auth.json.
export function parseCodexAccountLabel(idToken: unknown): string {
  if (typeof idToken !== 'string') return '';
  const payload = idToken.split('.')[1];
  if (!payload) return '';
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const email = typeof claims?.email === 'string' ? claims.email : '';
    const name = typeof claims?.name === 'string' ? claims.name : '';
    return name && email ? `${name} (${email})` : email || name;
  } catch {
    return '';
  }
}
