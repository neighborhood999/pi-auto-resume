const MINUTE_MS = 60_000;
const FIVE_HOURS_MS = 5 * 3_600_000;

/**
 * Resolve Claude bridge's timezone-qualified five-hour reset text to epoch milliseconds.
 * Unqualified clocks, weekly dates, and ambiguous/nonexistent local times stay unknown.
 */
export function parseClaudeBridgeReset(errorMessage: string, now: number): number | undefined {
  if (!errorMessage.startsWith('Claude rate limit (five_hour)') || !Number.isFinite(now)) {
    return undefined;
  }
  // The bridge prepends a host-local clock without a date or timezone. Only
  // Claude Code's trailing, explicitly zoned clock is usable independently of
  // the host. Do not generalize this daily clock to a weekly reset.
  const match =
    /· resets (\d{1,2})(?::(\d{2}))?\s*(am|pm) \(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)$/i.exec(
      errorMessage,
    );
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[3];
  const timeZone = match[4];
  if (hour < 1 || hour > 12 || minute > 59 || !meridiem || !timeZone) {
    return undefined;
  }
  const hour24 = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return undefined;
  }

  // A rolling five-hour limit bounds the missing date. Enumerating UTC minutes
  // avoids guessing a timezone offset or rolling nonexistent DST times forward.
  // Multiple matches (a DST fold) are deliberately not resolved by picking one.
  let resetAt: number | undefined;
  for (
    let candidate = Math.ceil(now / MINUTE_MS) * MINUTE_MS;
    candidate <= now + FIVE_HOURS_MS;
    candidate += MINUTE_MS
  ) {
    const parts = formatter.formatToParts(candidate);
    const localHour = Number(parts.find((part) => part.type === 'hour')?.value);
    const localMinute = Number(parts.find((part) => part.type === 'minute')?.value);

    if (candidate <= now || localHour !== hour24 || localMinute !== minute) {
      continue;
    }

    if (resetAt !== undefined) {
      return undefined;
    }

    resetAt = candidate;
  }

  return resetAt;
}
