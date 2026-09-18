import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHm,
  formatHm,
  formatHm12,
  addMinutes,
  computeSecureEndTime,
  localDateKey,
  rowDateFromKey,
  elapsedSince,
  formatElapsed,
  formatCountdown,
  formatDurationLong,
  progressRatio,
  derivePanelState,
  isOvernightRowStillRelevant,
} from "../src/lib/time.js";

const SAFE_DURATION_MINUTES = 8 * 60 + 30;

test("parseHm rejects 00:00, empty, and non-HH:MM values", () => {
  assert.equal(parseHm("00:00"), null);
  assert.equal(parseHm(""), null);
  assert.equal(parseHm("-"), null);
  assert.equal(parseHm("not a time"), null);
  assert.deepEqual(parseHm("09:59"), { h: 9, m: 59 });
  assert.deepEqual(parseHm(" 20:59 "), { h: 20, m: 59 });
});

test("formatHm zero-pads", () => {
  assert.equal(formatHm({ h: 5, m: 9 }), "05:09");
  assert.equal(formatHm({ h: 18, m: 29 }), "18:29");
});

test("formatHm12 — 12h AM/PM, used only by the Today panel (table column stays 24h)", () => {
  assert.equal(formatHm12({ h: 9, m: 5 }), "9:05 AM"); // single-digit hour
  assert.equal(formatHm12({ h: 18, m: 29 }), "6:29 PM"); // standard PM case
  assert.equal(formatHm12({ h: 12, m: 0 }), "12:00 PM"); // noon
  assert.equal(formatHm12({ h: 0, m: 0 }), "12:00 AM"); // midnight exactly — bare `h % 12` gets this wrong
  assert.equal(formatHm12({ h: 0, m: 5 }), "12:05 AM");
});

test("addMinutes wraps across midnight", () => {
  assert.deepEqual(addMinutes({ h: 20, m: 59 }, SAFE_DURATION_MINUTES), {
    h: 5,
    m: 29,
    crossesMidnight: true,
  });
  assert.deepEqual(addMinutes({ h: 9, m: 59 }, SAFE_DURATION_MINUTES), {
    h: 18,
    m: 29,
    crossesMidnight: false,
  });
});

test("computeSecureEndTime — the bug this rewrite exists to fix", () => {
  // Old code: hours %= 12 + hardcoded " PM" -> would have printed "08:59 PM"
  // for a 20:59 entry time. Correct 24h answer, crossing midnight:
  assert.equal(computeSecureEndTime("20:59", SAFE_DURATION_MINUTES), "05:29 (+1d)");
  assert.equal(computeSecureEndTime("09:59", SAFE_DURATION_MINUTES), "18:29");
  assert.equal(computeSecureEndTime("00:00", SAFE_DURATION_MINUTES), "—");
  assert.equal(computeSecureEndTime("", SAFE_DURATION_MINUTES), "—");
});

test("localDateKey formats local date components with zero-padding", () => {
  assert.equal(localDateKey(new Date(2026, 0, 5)), "2026-01-05"); // Jan 5 — single-digit month & day
  assert.equal(localDateKey(new Date(2026, 8, 14)), "2026-09-14");
});

test("rowDateFromKey extracts the date regardless of the user-id shape", () => {
  assert.equal(rowDateFromKey("3726-2026-09-14T00:00:00"), "2026-09-14");
  assert.equal(rowDateFromKey("-1-2026-09-14T00:00:00"), "2026-09-14"); // leading dash
  assert.equal(rowDateFromKey("garbage"), null);
});

test("elapsedSince clamps to zero and treats non-entries as null", () => {
  const now = new Date(2026, 8, 14, 12, 30, 0);
  assert.deepEqual(elapsedSince("09:59", now), { hours: 2, minutes: 31 });
  assert.deepEqual(elapsedSince("12:30", now), { hours: 0, minutes: 0 });
  // "future" start (clock skew) clamps rather than going negative
  assert.deepEqual(elapsedSince("23:00", now), { hours: 0, minutes: 0 });
  assert.equal(elapsedSince("00:00", now), null);
});

test("formatElapsed", () => {
  assert.equal(formatElapsed({ hours: 4, minutes: 12 }), "4h 12m in");
});

test("formatCountdown zero-pads all three fields", () => {
  assert.equal(formatCountdown(0), "00:00:00");
  assert.equal(formatCountdown(3_661_000), "01:01:01"); // 1h 1m 1s
  assert.equal(formatCountdown(-500), "00:00:00"); // never negative
});

test("formatDurationLong — human-readable, used for the panel's Time Spent figure", () => {
  assert.equal(formatDurationLong(0), "0h 0m 0s");
  assert.equal(formatDurationLong(3_661_000), "1h 1m 1s");
  assert.equal(formatDurationLong(9_010_000), "2h 30m 10s");
  assert.equal(formatDurationLong(-500), "0h 0m 0s"); // never negative
});

test("progressRatio clamps to [0,1]", () => {
  assert.equal(progressRatio(0, 100), 0);
  assert.equal(progressRatio(50, 100), 0.5);
  assert.equal(progressRatio(150, 100), 1); // overtime doesn't overflow a bar
  assert.equal(progressRatio(-10, 100), 0);
  assert.equal(progressRatio(50, 0), 0); // no divide-by-zero
});

test("derivePanelState: loading when there's no row yet", () => {
  assert.deepEqual(
    derivePanelState({
      hasRow: false,
      rowDateKey: null,
      startText: "",
      now: new Date(2026, 8, 14, 10, 0),
      durationMinutes: SAFE_DURATION_MINUTES,
    }),
    { kind: "loading" }
  );
});

test("derivePanelState: waiting when the row has no real (parseable) start time", () => {
  for (const startText of ["00:00", "", "-"]) {
    const state = derivePanelState({
      hasRow: true,
      rowDateKey: "2026-09-14",
      startText,
      statusText: "Casual Leave",
      now: new Date(2026, 8, 14, 10, 0),
      durationMinutes: SAFE_DURATION_MINUTES,
    });
    assert.deepEqual(state, { kind: "waiting", statusText: "Casual Leave" });
  }
});

test("derivePanelState: running, mid-shift — 12h labels, not the table's 24h", () => {
  const state = derivePanelState({
    hasRow: true,
    rowDateKey: "2026-09-14",
    startText: "09:59",
    statusText: "Normal",
    now: new Date(2026, 8, 14, 12, 30),
    durationMinutes: SAFE_DURATION_MINUTES,
  });
  assert.equal(state.kind, "running");
  assert.equal(state.start, "9:59 AM");
  assert.equal(state.end, "6:29 PM");
  assert.equal(state.inOffice, "2h 31m 0s");
  assert.equal(state.remaining, "05:59:00");
  assert.ok(state.ratio > 0 && state.ratio < 1);
});

test("derivePanelState: a mid-day End Time punch does NOT freeze/alter a still-running countdown — the reported bug", () => {
  // Old code: any parseable, non-"00:00" End Time forced `done`, echoing it
  // as the "actual checkout" — even at 11:05, minutes into the shift. End
  // Time is rewritten on every ID-card punch (100+/day), not just a final
  // checkout, so this must have no effect on the panel's state at all.
  const state = derivePanelState({
    hasRow: true,
    rowDateKey: "2026-09-14",
    startText: "09:59",
    statusText: "Normal",
    now: new Date(2026, 8, 14, 11, 5),
    durationMinutes: SAFE_DURATION_MINUTES,
  });
  assert.equal(state.kind, "running");
  assert.equal(state.remaining, "07:24:00");
});

test("derivePanelState: timeup once Secure End Time is reached — no growing overtime counter", () => {
  const state = derivePanelState({
    hasRow: true,
    rowDateKey: "2026-09-14",
    startText: "09:59",
    now: new Date(2026, 8, 14, 19, 6),
    durationMinutes: SAFE_DURATION_MINUTES,
  });
  assert.equal(state.kind, "timeup");
  assert.equal(state.end, "6:29 PM");
  assert.equal(state.over, undefined); // no growing "how far past" figure
});

test("derivePanelState: overnight shift (start yesterday) computes a positive remaining, not a wrapped-negative one", () => {
  // start 20:59 on the 14th -> secure end 05:29 on the 15th. Observed at
  // 01:00 on the 15th, 4h29m should remain — this is the case a
  // date-naive implementation gets backwards.
  const state = derivePanelState({
    hasRow: true,
    rowDateKey: "2026-09-14",
    startText: "20:59",
    now: new Date(2026, 8, 15, 1, 0),
    durationMinutes: SAFE_DURATION_MINUTES,
  });
  assert.equal(state.kind, "running");
  assert.equal(state.end, "5:29 AM");
  assert.equal(state.remaining, "04:29:00");
  assert.equal(state.inOffice, "4h 1m 0s");
});

test("derivePanelState: clock skew (now before start) clamps elapsed to zero instead of adding a day", () => {
  // Same shape of inputs as the overnight case above (now < start-of-day
  // arithmetic could wrap either way) but here `now` is simply earlier the
  // same day as a stale/skewed reading — elapsed must clamp to zero, not
  // become "23h31m", and remaining must be the full shift, not negative.
  const state = derivePanelState({
    hasRow: true,
    rowDateKey: "2026-09-14",
    startText: "09:59",
    now: new Date(2026, 8, 14, 9, 30),
    durationMinutes: SAFE_DURATION_MINUTES,
  });
  assert.equal(state.kind, "running");
  assert.equal(state.inOffice, "0h 0m 0s");
  assert.equal(state.remaining, "08:59:00");
});

test("isOvernightRowStillRelevant: true within one shift-duration past Secure End Time", () => {
  // start 20:59 on the 14th -> secure end 05:29 on the 15th -> relevant
  // until 13:59 on the 15th (one more full 8h30 past secure end).
  assert.equal(
    isOvernightRowStillRelevant("20:59", "2026-09-14", new Date(2026, 8, 15, 1, 0), SAFE_DURATION_MINUTES),
    true
  );
  assert.equal(
    isOvernightRowStillRelevant("20:59", "2026-09-14", new Date(2026, 8, 15, 13, 0), SAFE_DURATION_MINUTES),
    true
  );
});

test("isOvernightRowStillRelevant: false well past the bound — an ordinary completed previous day, not an overnight shift", () => {
  // A normal 09:59-start day is long expired by the next morning — this is
  // what stops "yesterday" from matching every ordinary completed day,
  // every single morning, before today's own row exists.
  assert.equal(
    isOvernightRowStillRelevant("09:59", "2026-09-14", new Date(2026, 8, 15, 8, 0), SAFE_DURATION_MINUTES),
    false
  );
});

test("isOvernightRowStillRelevant: false when Start Time isn't parseable", () => {
  assert.equal(
    isOvernightRowStillRelevant("00:00", "2026-09-14", new Date(2026, 8, 15, 1, 0), SAFE_DURATION_MINUTES),
    false
  );
});
