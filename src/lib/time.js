// @ts-check
// Pure time math for the "Secure End Time" column. No DOM in this file —
// that's what makes it the one thing in this extension worth unit testing.

/**
 * Parse an "HH:MM" string from the portal into numeric parts.
 * Treats "00:00", empty, "-" and anything not shaped like HH:MM as "no entry"
 * (the portal renders 00:00/00:00 for leave days and not-logged-in days).
 * @param {string} value
 * @returns {{h:number,m:number}|null}
 */
export function parseHm(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,2}:\d{2}$/.test(trimmed)) return null;
  if (trimmed === "00:00") return null;
  const [h, m] = trimmed.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {{h:number,m:number}} t */
export function formatHm(t) {
  return `${pad2(t.h)}:${pad2(t.m)}`;
}

/**
 * 12-hour AM/PM formatting, used ONLY by the Today panel (derivePanelState)
 * — the table column stays 24h via formatHm above, deliberately different
 * formats for the two surfaces. `h % 12 || 12` (not bare `h % 12`) is
 * required: a Secure End Time can itself land exactly on {h:0,m:0} (e.g. a
 * 15:30 start + 8h30), not just an odd minute past midnight, and a bare
 * `% 12` would print "0:00 AM" instead of "12:00 AM".
 * @param {{h:number,m:number}} t
 */
export function formatHm12(t) {
  const period = t.h < 12 ? "AM" : "PM";
  const hour12 = t.h % 12 || 12;
  return `${hour12}:${pad2(t.m)} ${period}`;
}

/**
 * Add a duration (in minutes) to a 24h time, wrapping across midnight.
 * The portal renders 24-hour times, so this replaces the old `hours %= 12`
 * + hardcoded " PM" logic, which was wrong the moment a start time was in
 * the evening (20:59 -> would have printed "08:59 PM" instead of 05:29 +1d).
 * @param {{h:number,m:number}} start
 * @param {number} durationMinutes
 * @returns {{h:number,m:number,crossesMidnight:boolean}}
 */
export function addMinutes(start, durationMinutes) {
  const DAY = 24 * 60;
  const total = start.h * 60 + start.m + durationMinutes;
  const wrapped = ((total % DAY) + DAY) % DAY;
  return { h: Math.floor(wrapped / 60), m: wrapped % 60, crossesMidnight: total >= DAY };
}

/**
 * Compute the "Secure End Time" cell text for a raw Start Time cell value.
 * @param {string} startTimeText
 * @param {number} durationMinutes
 * @returns {string} e.g. "18:29", "05:29 (+1d)", or "—" for no entry
 */
export function computeSecureEndTime(startTimeText, durationMinutes) {
  const start = parseHm(startTimeText);
  if (!start) return "—";
  const end = addMinutes(start, durationMinutes);
  return end.crossesMidnight ? `${formatHm(end)} (+1d)` : formatHm(end);
}

/**
 * Format a Date as a local "YYYY-MM-DD" key. Deliberately NOT toISOString()
 * — that reads UTC, so before ~06:00 local in Dhaka (UTC+6) it would return
 * yesterday's date and silently move "today"'s row.
 * @param {Date} date
 */
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Extract a "YYYY-MM-DD" date from an AntD row key such as
 * "3726-2026-09-14T00:00:00". Matches the date pattern anywhere in the
 * string (rather than "everything after the first dash") so it survives a
 * different user-id shape.
 * @param {string} rowKey
 * @returns {string|null}
 */
export function rowDateFromKey(rowKey) {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(rowKey || "");
  return match ? match[1] : null;
}

/**
 * Minutes elapsed between a start time and now, clamped to zero to absorb
 * clock skew or a future-looking start time.
 * @param {string} startTimeText
 * @param {Date} now
 * @returns {{hours:number,minutes:number}|null} null if start is not a real entry
 */
export function elapsedSince(startTimeText, now) {
  const start = parseHm(startTimeText);
  if (!start) return null;
  const target = new Date(now);
  target.setHours(start.h, start.m, 0, 0);
  const diffMs = Math.max(0, now.getTime() - target.getTime());
  const totalMinutes = Math.floor(diffMs / 60000);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** @param {{hours:number,minutes:number}} elapsed */
export function formatElapsed(elapsed) {
  return `${elapsed.hours}h ${elapsed.minutes}m in`;
}

/**
 * Build a local Date for a portal row's own date plus an "HH:MM" time. Used
 * instead of anchoring everything to `now`'s date, which is what makes an
 * overnight shift (started yesterday, still open after midnight) compute
 * correctly instead of being indistinguishable from ordinary clock skew —
 * see derivePanelState.
 * @param {string} dateKey "YYYY-MM-DD"
 * @param {{h:number,m:number}} hm
 * @returns {Date}
 */
function dateTimeAt(dateKey, hm) {
  const [y, mo, d] = dateKey.split("-").map(Number);
  return new Date(y, mo - 1, d, hm.h, hm.m, 0, 0);
}

/**
 * Whether a previous day's row should still be treated as an overnight
 * shift in progress, rather than a stale completed day sitting around while
 * waiting for today's own row to appear (see attendance.js's
 * captureTodayRowSnapshot). Deliberately does NOT read End Time — that
 * field is rewritten on every ID-card punch, not just a final checkout, so
 * "End Time is non-empty" was never real evidence the shift had ended (that
 * was the source of the original bug this replaces). Instead this bounds
 * relevance purely from Start Time + duration: still active until one full
 * shift-duration past its own Secure End Time. That's generous enough to
 * cover a real overnight shift sitting in `timeup` for a while after
 * crossing over, while still expiring well before "yesterday" would
 * otherwise match every single ordinary completed day, every morning, for
 * the many hours before today's own row exists.
 * @param {string} startText
 * @param {string} rowDateKey "YYYY-MM-DD" — the row's own date, e.g. yesterday's
 * @param {Date} now
 * @param {number} durationMinutes
 */
export function isOvernightRowStillRelevant(startText, rowDateKey, now, durationMinutes) {
  const start = parseHm(startText);
  if (!start) return false;
  const end = addMinutes(start, durationMinutes);
  const endDate = dateTimeAt(rowDateKey, end);
  if (end.crossesMidnight) endDate.setDate(endDate.getDate() + 1);
  const cutoff = new Date(endDate.getTime() + durationMinutes * 60_000);
  return now.getTime() < cutoff.getTime();
}

/**
 * Format a non-negative millisecond duration as zero-padded "HH:MM:SS".
 * @param {number} ms
 */
export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/**
 * Format a non-negative millisecond duration as "Xh Ym Zs" — used for the
 * panel's "Time Spent" figure, where a human-readable duration reads better
 * than the zero-padded "HH:MM:SS" the countdown itself uses.
 * @param {number} ms
 */
export function formatDurationLong(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

/**
 * Fraction of the work day elapsed, clamped to [0,1] so overtime can't push
 * a progress bar past full.
 * @param {number} elapsedMs
 * @param {number} totalMs
 */
export function progressRatio(elapsedMs, totalMs) {
  if (totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, elapsedMs / totalMs));
}

/**
 * Pure state for the "Today" countdown panel. This panel answers ONE
 * question — how long until Secure End Time (Start + durationMinutes) — and
 * deliberately ignores the portal's own End Time field entirely: End Time is
 * rewritten on every ID-card punch (100+/day across the building), not just
 * a final checkout, so it is a punch log, not a "the day is over" flag.
 * There is no reliable signal for "the person has actually left" available
 * here, so this function doesn't try to detect one, and neither `running`
 * nor `timeup` claims the person is still physically present — `inOffice`
 * is labelled "Time Spent" by panel.js, reporting elapsed-since-clock-in
 * rather than an unbounded "in office" presence claim.
 *
 * `rowDateKey` — the date the matched row itself belongs to, not `now`'s
 * date — is what lets this tell an overnight shift ("start 20:59 yesterday,
 * now 01:00" -> positive remaining) apart from ordinary clock skew ("start
 * 09:59 today, now 09:30 today" -> zero elapsed, not a day added). Passing
 * only `now`'s date for both would make one of those two cases wrong.
 *
 * @param {{
 *   hasRow: boolean,
 *   rowDateKey: string|null,
 *   startText: string,
 *   statusText?: string,
 *   now: Date,
 *   durationMinutes: number,
 * }} args
 */
export function derivePanelState({ hasRow, rowDateKey, startText, statusText, now, durationMinutes }) {
  const status = statusText || "";
  if (!hasRow || !rowDateKey) return { kind: "loading" };

  const start = parseHm(startText);
  if (!start) return { kind: "waiting", statusText: status };

  const end = addMinutes(start, durationMinutes);
  const endDate = dateTimeAt(rowDateKey, end);
  if (end.crossesMidnight) endDate.setDate(endDate.getDate() + 1);

  const startDate = dateTimeAt(rowDateKey, start);
  const elapsedMs = Math.max(0, now.getTime() - startDate.getTime());
  const inOffice = formatDurationLong(elapsedMs);

  const remainingMs = endDate.getTime() - now.getTime();
  if (remainingMs <= 0) {
    // Frozen, not a growing overtime counter: once Secure End Time is
    // reached the countdown stops at 00:00:00 and stays there — the
    // "time's up, you're clear to go" alarm — rather than counting how far
    // past it you've gone.
    return {
      kind: "timeup",
      statusText: status,
      start: formatHm12(start),
      end: formatHm12(end),
      inOffice,
    };
  }

  return {
    kind: "running",
    statusText: status,
    start: formatHm12(start),
    end: formatHm12(end),
    inOffice,
    remaining: formatCountdown(remainingMs),
    ratio: progressRatio(elapsedMs, durationMinutes * 60_000),
  };
}
