import { describe, it, expect } from 'vitest';
import {
  parseLimits,
  parseDevinQuota,
  isDevinQuotaStale,
  formatDevinStatusText,
  formatProgressBar,
  getColor,
  getStatusEmoji,
  formatStatusText,
  formatSevenDaySonnetText,
  parseCodexLimitsFromJsonLine,
  parseCodexLimitsFromSessionLog,
  parseCodexLimitsFromWhamUsage,
  parseCodexLimitsFromAppServerRateLimits,
  parseCodexAccountLabel,
  formatCodexStatusText,
  shouldShowService,
} from './limits';


describe('parseLimits', () => {
  it('parses valid JSON with both limits', () => {
    const json = {
      five_hour: { used_percentage: 42 },
      seven_day: { used_percentage: 18 }
    };
    const result = parseLimits(JSON.stringify(json));
    expect(result).toMatchObject({ fiveHour: 42, sevenDay: 18 });
  });

  it('returns null for invalid JSON', () => {
    expect(parseLimits('not json')).toBeNull();
  });

  it('returns null for missing fields', () => {
    expect(parseLimits('{}')).toBeNull();
  });

  it('parses seven_day_sonnet when present', () => {
    const json = {
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20 },
      seven_day_sonnet: { used_percentage: 5 }
    };
    const result = parseLimits(JSON.stringify(json));
    expect(result?.sevenDaySonnet).toBe(5);
  });

  it('omits sevenDaySonnet when seven_day_sonnet missing', () => {
    const json = {
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20 }
    };
    const result = parseLimits(JSON.stringify(json));
    expect(result?.sevenDaySonnet).toBeUndefined();
  });

  it('omits sevenDaySonnet when utilization is 0', () => {
    const json = {
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20 },
      seven_day_sonnet: { used_percentage: 0 }
    };
    const result = parseLimits(JSON.stringify(json));
    expect(result?.sevenDaySonnet).toBeUndefined();
  });
});

describe('shouldShowService', () => {
  it('shows auto mode only for a connected service', () => {
    expect(shouldShowService('auto', true)).toBe(true);
    expect(shouldShowService('auto', false)).toBe(false);
  });

  it('supports explicit always and hidden modes', () => {
    expect(shouldShowService('always', false)).toBe(true);
    expect(shouldShowService('hidden', true)).toBe(false);
  });
});

describe('formatProgressBar', () => {
  it('shows empty bar for 0%', () => {
    expect(formatProgressBar(0)).toBe('░░░░░░');
  });

  it('shows full bar for 100%', () => {
    expect(formatProgressBar(100)).toBe('██████');
  });

  it('shows half bar for 50%', () => {
    expect(formatProgressBar(50)).toBe('███░░░');
  });

  it('rounds correctly for 42%', () => {
    expect(formatProgressBar(42)).toBe('███░░░');
  });
});

describe('getColor', () => {
  it('returns green for low usage', () => {
    expect(getColor(30)).toBe('green');
  });

  it('returns yellow for medium usage', () => {
    expect(getColor(60)).toBe('yellow');
  });

  it('returns red for high usage', () => {
    expect(getColor(85)).toBe('red');
  });

  it('returns yellow at exactly 50%', () => {
    expect(getColor(50)).toBe('yellow');
  });

  it('returns red at exactly 80%', () => {
    expect(getColor(80)).toBe('red');
  });
});

describe('getStatusEmoji', () => {
  it('returns empty string for low usage', () => {
    expect(getStatusEmoji(30)).toBe('');
  });

  it('returns empty just below threshold', () => {
    expect(getStatusEmoji(59)).toBe('');
  });

  it('returns yellow circle at exactly 60%', () => {
    expect(getStatusEmoji(60)).toBe('🟡');
  });

  it('returns yellow circle at 79%', () => {
    expect(getStatusEmoji(79)).toBe('🟡');
  });

  it('returns red circle at exactly 80%', () => {
    expect(getStatusEmoji(80)).toBe('🔴');
  });

  it('returns red circle for high usage', () => {
    expect(getStatusEmoji(95)).toBe('🔴');
  });
});

describe('formatStatusText', () => {
  it('shows no emoji below 60% (en)', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 25 });
    expect(result).toBe('Claude: Session: ███░░░ 50% | Week: ██░░░░ 25%');
  });

  it('shows no emoji below 60% (ru)', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 25 }, 'ru');
    expect(result).toBe('Claude: Сессия: ███░░░ 50% | Неделя: ██░░░░ 25%');
  });

  it('handles 0% values without emoji', () => {
    const result = formatStatusText({ fiveHour: 0, sevenDay: 0 }, 'ru');
    expect(result).toBe('Claude: Сессия: ░░░░░░ 0% | Неделя: ░░░░░░ 0%');
  });

  it('shows yellow circle in 60-79% range', () => {
    const result = formatStatusText({ fiveHour: 65, sevenDay: 25 }, 'ru');
    expect(result).toBe('Claude: Сессия: ████░░ 🟡65% | Неделя: ██░░░░ 25%');
  });

  it('shows red circle at 80%+', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 85 }, 'ru');
    expect(result).toBe('Claude: Сессия: ███░░░ 50% | Неделя: █████░ 🔴85%');
  });

  it('appends Sonnet block when sevenDaySonnet is present', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 25, sevenDaySonnet: 85 }, 'ru');
    expect(result).toBe('Claude: Сессия: ███░░░ 50% | Неделя: ██░░░░ 25% | S: 🔴85%');
  });

  it('does not append Sonnet block when missing', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 25 }, 'ru');
    expect(result).toBe('Claude: Сессия: ███░░░ 50% | Неделя: ██░░░░ 25%');
  });

  it('shows Sonnet without emoji below 60%', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 25, sevenDaySonnet: 10 }, 'ru');
    expect(result).toBe('Claude: Сессия: ███░░░ 50% | Неделя: ██░░░░ 25% | S: 10%');
  });

  it('uses English labels with Sonnet block', () => {
    const result = formatStatusText({ fiveHour: 50, sevenDay: 25, sevenDaySonnet: 85 }, 'en');
    expect(result).toBe('Claude: Session: ███░░░ 50% | Week: ██░░░░ 25% | S: 🔴85%');
  });
});

describe('formatSevenDaySonnetText', () => {
  it('returns null when sevenDaySonnet is undefined', () => {
    expect(formatSevenDaySonnetText({ fiveHour: 0, sevenDay: 0 })).toBeNull();
  });

  it('formats Sonnet without emoji when below 60%', () => {
    expect(formatSevenDaySonnetText({ fiveHour: 0, sevenDay: 0, sevenDaySonnet: 25 })).toBe('S: 25%');
  });

  it('formats Sonnet with yellow circle at 65%', () => {
    const limits = { fiveHour: 0, sevenDay: 0, sevenDaySonnet: 65, sevenDaySonnetResetsAt: '2099-01-01T00:00:00Z' };
    expect(formatSevenDaySonnetText(limits)).toBe('S: 🟡65%');
  });

  it('formats Sonnet with red circle at 80%+', () => {
    expect(formatSevenDaySonnetText({ fiveHour: 0, sevenDay: 0, sevenDaySonnet: 85 })).toBe('S: 🔴85%');
  });
});

describe('parseCodexLimits', () => {
  it('parses primary and secondary rate limits from a Codex token_count event', () => {
    const line = JSON.stringify({
      payload: {
        rate_limits: {
          primary: { used_percent: 50.4, window_minutes: 10080, resets_at: 4070908800 },
          secondary: { used_percent: 12.2, window_minutes: 300, resets_at: 4070908800 },
          plan_type: 'plus'
        }
      }
    });

    const result = parseCodexLimitsFromJsonLine(line);
    expect(result?.primary).toMatchObject({ usedPercent: 50, windowMinutes: 10080 });
    expect(result?.secondary).toMatchObject({ usedPercent: 12, windowMinutes: 300 });
    expect(result?.planType).toBe('plus');
  });

  it('uses the latest rate_limits event in a Codex session log', () => {
    const first = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } } });
    const second = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 25, window_minutes: 10080 } } } });

    const result = parseCodexLimitsFromSessionLog(`${first}\n${second}`);
    expect(result?.primary?.usedPercent).toBe(25);
  });

  it('parses Codex WHAM usage windows', () => {
    const json = JSON.stringify({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: 4070908800 },
        secondary_window: { used_percent: 50.1, limit_window_seconds: 604800, reset_at: 4070908800 }
      }
    });

    const result = parseCodexLimitsFromWhamUsage(json);
    expect(result?.primary).toMatchObject({ usedPercent: 12, windowMinutes: 300 });
    expect(result?.secondary).toMatchObject({ usedPercent: 50, windowMinutes: 10080 });
    expect(result?.planType).toBe('plus');
  });

  it('parses the live app-server response with a weekly window only', () => {
    const result = parseCodexLimitsFromAppServerRateLimits({
      primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 4070908800 },
      secondary: null,
      planType: 'plus'
    });

    expect(result).toMatchObject({
      primary: { usedPercent: 9, windowMinutes: 10080 },
      secondary: undefined,
      planType: 'plus'
    });
    expect(formatCodexStatusText(result!, 'ru')).toMatch(/^Codex: Неделя: █░░░░░ 9% \(~/);
  });

  it('formats Codex session and week bars with the same labels', () => {
    const result = formatCodexStatusText({
      primary: { usedPercent: 50, windowMinutes: 10080 },
      secondary: { usedPercent: 12, windowMinutes: 300 }
    }, 'en');

    expect(result).toBe('Codex: Session: █░░░░░ 12% | Week: ███░░░ 50%');
  });

  it('includes an individual Codex limit when present', () => {
    const result = formatCodexStatusText({
      primary: { usedPercent: 50, windowMinutes: 10080 },
      secondary: { usedPercent: 12, windowMinutes: 300 },
      individual: { usedPercent: 85, windowMinutes: 10080, label: 'I' }
    }, 'en');

    expect(result).toBe('Codex: Session: █░░░░░ 12% | Week: ███░░░ 50% | I: 🔴85%');
  });
});

describe('parseCodexAccountLabel', () => {
  function makeToken(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `header.${payload}.signature`;
  }

  it('combines name and email', () => {
    expect(parseCodexAccountLabel(makeToken({ name: 'Сергей', email: 'user@example.com' })))
      .toBe('Сергей (user@example.com)');
  });

  it('falls back to email when the name is missing', () => {
    expect(parseCodexAccountLabel(makeToken({ email: 'user@example.com' }))).toBe('user@example.com');
  });

  it('falls back to name when the email is missing', () => {
    expect(parseCodexAccountLabel(makeToken({ name: 'Сергей' }))).toBe('Сергей');
  });

  it('returns an empty string for tokens without account claims', () => {
    expect(parseCodexAccountLabel(makeToken({ sub: 'abc' }))).toBe('');
  });

  it('returns an empty string for malformed input', () => {
    expect(parseCodexAccountLabel('not-a-jwt')).toBe('');
    expect(parseCodexAccountLabel('header.@@@notbase64@@@.signature')).toBe('');
    expect(parseCodexAccountLabel(undefined)).toBe('');
    expect(parseCodexAccountLabel(null)).toBe('');
  });
});

describe('Devin quota', () => {
  const sample = JSON.stringify({
    weekly_percent: 32, weekly_reset_at: '2026-09-27T00:00:00-08:00', daily_percent: 0,
    daily_reset_at: '2026-09-26T00:00:00-08:00', hide_daily_quota: true, on_demand_credits_usd: 10,
    trailing_7d_acus: 0, quota_sampled_at: '2026-09-25T13:15:58+00:00', last_error: null,
  });

  it('parses the Sandy summary and hides the daily quota when the page hides it', () => {
    const q = parseDevinQuota(sample)!;
    expect(q.weeklyPercent).toBe(32);
    expect(q.dailyPercent).toBeUndefined();
    expect(q.onDemandCreditsUsd).toBe(10);
    expect(q.lastError).toBeUndefined();
  });

  it('rejects summaries without a weekly percent', () => {
    expect(parseDevinQuota('{"weekly_percent":null}')).toBeNull();
    expect(parseDevinQuota('not json')).toBeNull();
  });

  it('marks samples older than 90 minutes as stale', () => {
    const q = parseDevinQuota(sample)!;
    const at = new Date('2026-09-25T13:15:58Z').getTime();
    expect(isDevinQuotaStale(q, at + 60 * 60_000)).toBe(false);
    expect(isDevinQuotaStale(q, at + 91 * 60_000)).toBe(true);
    expect(isDevinQuotaStale({ weeklyPercent: 1 })).toBe(true);
  });

  it('formats percent, reset and optional daily quota', () => {
    const q = { weeklyPercent: 32, weeklyResetsAt: new Date(Date.now() + 26 * 3600_000 + 60_000).toISOString() };
    expect(formatDevinStatusText(q, 'en', false)).toBe('Devin Week: 32% (~1d 2h)');
    expect(formatDevinStatusText({ weeklyPercent: 85, dailyPercent: 40 }, 'en', false)).toBe('Devin Week: 🔴85% · D 40%');
  });
});
