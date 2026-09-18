// Shared constants. Kept as plain values (not chrome.storage) — this is a
// single-user utility and SAFE_DURATION is fixed by company policy, so a
// rebuild-to-change constant is the right amount of configurability.

export const COLUMN_TITLE = "Secure End Time";
export const SAFE_DURATION_MINUTES = 8 * 60 + 30; // 8h30m

// Every node we inject carries this attribute. It is what makes sync()
// idempotent (remove everything marked, then rebuild) instead of relying on
// a "does the column already exist" guard that never refreshes.
export const MARKER_ATTR = "data-cto";

// The Today panel is a SEPARATE lifecycle from the column above (see
// CLAUDE.md) — it is create-once + update-in-place, not remove-then-rebuild
// — so it deliberately does NOT share MARKER_ATTR: removeInjected() must
// never touch it, or the running clock (and its DOM node identity) would be
// destroyed on every 200ms debounce tick.
export const PANEL_ATTR = "data-cto-panel";
// Stamped only as the LAST step of building the panel. Any panel node found
// without this is the leftover of a build that threw partway through, and
// must be treated as garbage and rebuilt rather than left in place forever.
export const PANEL_READY_ATTR = "data-cto-panel-ready";
// A dedicated build counter (never resets), separate from the column's
// data-cto-syncs — that counter increments on every table re-render and
// can't answer "was the panel rebuilt", only "did the table resync".
export const PANEL_BUILDS_ATTR = "data-cto-panel-builds";

// Only run on the Attendance page. Checked against location.pathname (not
// location.href), so query-string changes from sorting/filtering don't
// affect it.
export const ROUTE_RE = /^\/attendance\/?$/;

export const HEADER_TEXT = {
  date: "date",
  startTime: "start time",
  endTime: "end time",
  status: "status",
};

export const SYNC_DEBOUNCE_MS = 200;
export const TICK_INTERVAL_MS = 60_000;
export const PANEL_CLOCK_INTERVAL_MS = 1_000;
export const PANEL_TITLE_PREFIX = "⏰ Time's up · ";

// Safety valve for a re-render loop that measurement did not find in
// practice, but that costs five lines to make structurally impossible.
export const SYNC_BURST_LIMIT = 20;
export const SYNC_BURST_WINDOW_MS = 10_000;

// --- Members-directory tracker -------------------------------------------
// Only run on the member directory page. A SECOND route export, deliberately
// not merged into ROUTE_RE — widening that regex would make the attendance
// column try to inject on this page too. Each feature owns its own route.
export const MEMBERS_ROUTE_RE = /^\/members-directory\/?$/;

// The directory bar's own marker family, separate from both MARKER_ATTR
// (the attendance column's remove-then-rebuild set) and PANEL_ATTR (the
// Today panel's create-once set) — this feature has its own create-once
// lifecycle and must not be touched by removeInjected() or sweepOrphanPanels().
export const DIR_ATTR = "data-cto-dir";
// Stamped only as the LAST step of building the bar, mirroring PANEL_READY_ATTR:
// a bar found without this is the leftover of a build that threw partway
// through, and must be treated as garbage and rebuilt.
export const DIR_READY_ATTR = "data-cto-dir-ready";
// A dedicated build counter on <html>, separate from PANEL_BUILDS_ATTR and
// data-cto-syncs — neither of those can answer "was the directory bar
// rebuilt", since both climb on correct, unrelated code.
export const DIR_BUILDS_ATTR = "data-cto-dir-builds";
// Bumped on every persisted Snap/Track/Untrack, independent of DIR_BUILDS_ATTR
// (which counts DOM rebuilds, not writes) — this is what proves in production
// that a click actually reached storage, readable from the Elements panel.
export const DIR_SNAPS_ATTR = "data-cto-dir-snaps";

export const STORAGE_KEY = "cto-members-v1";
export const STORAGE_VERSION = 1;

// Below this many scraped cards, Track/Snap refuse outright rather than
// recording a tiny "roster" — see the plan's "hard floor" for why this
// specifically protects the FIRST snap, which has no prior total to compare
// against.
export const MIN_ABSOLUTE_CARDS = 25;
