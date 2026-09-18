// The attendance feature: the "Secure End Time" column and the Today
// countdown panel. Extracted from index.js (which used to own every feature
// this extension has) so that a second feature — the members-directory
// tracker — has its own module instead of growing index.js indefinitely.
// index.js now only owns the shared lifecycle: the observer, the debounce,
// the burst guard, and feature dispatch.
//
// Every invariant documented in CLAUDE.md for this feature moved verbatim:
// remove-then-rebuild for the column, create-once + update-in-place for the
// panel, snapshot-at-sync data for the clock, Text.data (never textContent)
// for the per-second repaint, and the panel's own teardown paths.
/* global __VERSION__, __TARGET__ */

import {
  findTable,
  getHeaderTexts,
  computeIndices,
  removeInjected,
  injectColumn,
  findSummaryMount,
  cellText,
  DATA_ROW_SELECTOR,
} from "./table.js";
import { createPanel, renderPanel } from "./panel.js";
import {
  computeSecureEndTime,
  elapsedSince,
  formatElapsed,
  rowDateFromKey,
  localDateKey,
  derivePanelState,
  isOvernightRowStillRelevant,
} from "../lib/time.js";
import {
  ROUTE_RE,
  SAFE_DURATION_MINUTES,
  MARKER_ATTR,
  PANEL_ATTR,
  PANEL_READY_ATTR,
  PANEL_BUILDS_ATTR,
  PANEL_CLOCK_INTERVAL_MS,
  PANEL_TITLE_PREFIX,
} from "../lib/config.js";
import { withApplying } from "./applying.js";
import { log, warn } from "../lib/log.js";

let syncCount = 0;

// --- Today panel state --------------------------------------------------
// Deliberately separate from the column's remove-then-rebuild state below:
// the panel survives a data refetch with its node identity intact (measured
// against the live portal — see the plan), so it is create-once and
// update-in-place instead. See CLAUDE.md for the full rationale.
let panel = null; // { node, refs, mode } | null
let panelSnapshot = null; // raw row text captured at sync time, or {hasRow:false}, or null (no panel)
let panelBuildCount = 0;
let clockTimer = null;
let previousPanelKind = null; // for the notification's edge-crossing rule
let titleAlertActive = false;
let baseTitle = null;

/**
 * Build the per-row cell-text function for one sync pass. Closes over the
 * column indices so table.js never needs to know about start/end times.
 * @param {number} srcIdx
 * @param {number} endIdx
 */
function makeCellTextFn(srcIdx, endIdx) {
  const today = localDateKey(new Date());
  return function cellTextFor(row) {
    const startTimeText = row.children[srcIdx]?.textContent.trim() ?? "";
    const secureEnd = computeSecureEndTime(startTimeText, SAFE_DURATION_MINUTES);
    if (secureEnd === "—") return secureEnd;

    const rowKey = row.getAttribute("data-row-key") || "";
    if (rowDateFromKey(rowKey) !== today) return secureEnd;

    // Only show elapsed time for today while still clocked in. Once End
    // Time is populated the portal's own Total Work Hour is authoritative.
    const endTimeText = row.children[endIdx]?.textContent.trim() ?? "";
    const stillClockedIn = endTimeText === "" || endTimeText === "00:00";
    if (!stillClockedIn) return secureEnd;

    const elapsed = elapsedSince(startTimeText, new Date());
    return elapsed ? `${secureEnd} · ${formatElapsed(elapsed)}` : secureEnd;
  };
}

// --- Today panel ---------------------------------------------------------

/**
 * Find today's row (or an overnight shift still open from yesterday) and
 * capture the raw cell text the panel needs. A snapshot, not a live
 * reference: the 1s clock recomputes derivePanelState from this snapshot
 * plus a fresh `now` rather than re-querying the DOM every second, so the
 * panel's countdown keeps ticking correctly even mid-rebuild, and its DATA
 * only changes on the next real sync (matching the "toggle Weekends -> the
 * clock must not reset" invariant with actually-fresh data, not stale data
 * that merely looks unchanged).
 *
 * Returns `null` when the table has rows but none is today's — the panel
 * should not exist at all in that case (see ensurePanel).
 */
function captureTodayRowSnapshot(wrapper, indices) {
  const rows = wrapper.querySelectorAll(DATA_ROW_SELECTOR);
  if (!rows.length) return { hasRow: false };

  const todayKey = localDateKey(new Date());
  const yesterdayKey = localDateKey(new Date(Date.now() - 86_400_000));

  for (const row of rows) {
    if (rowDateFromKey(row.getAttribute("data-row-key") || "") === todayKey) {
      return rowSnapshot(row, indices, todayKey);
    }
  }

  // No row for today yet — an overnight shift from yesterday still counts,
  // but no longer decided by yesterday's End Time cell: that field is
  // rewritten on every ID-card punch, not just a final checkout, so "End
  // Time is non-empty" was never real evidence the shift had ended — it
  // used to make a punch anywhere during the night reject yesterday's row
  // entirely and tear the panel down (see CLAUDE.md). Bounded instead by
  // isOvernightRowStillRelevant (Start Time + duration only), which also
  // keeps this from matching every ordinary completed previous day, every
  // single morning, for the hours before today's own row exists.
  for (const row of rows) {
    if (rowDateFromKey(row.getAttribute("data-row-key") || "") !== yesterdayKey) continue;
    const startText = cellText(row, indices.srcIdx);
    if (isOvernightRowStillRelevant(startText, yesterdayKey, new Date(), SAFE_DURATION_MINUTES)) {
      return rowSnapshot(row, indices, yesterdayKey);
    }
  }

  return null;
}

function rowSnapshot(row, indices, rowDateKey) {
  return {
    hasRow: true,
    rowDateKey,
    startText: cellText(row, indices.srcIdx),
    statusText: cellText(row, indices.statusIdx),
  };
}

/**
 * `null` return means "don't show a panel at all" (today filtered out of
 * the current date range) — distinct from `{hasRow:false}` ("loading"),
 * which still renders a panel with placeholder dashes. Conflating the two
 * would either flash a false claim on every cold load (the mount exists
 * ~70ms before any row does) or silently hide the panel forever if the data
 * XHR fails.
 */
function computePanelSnapshot() {
  const wrapper = findTable();
  if (!wrapper) return { hasRow: false };
  const indices = computeIndices(getHeaderTexts(wrapper));
  if (!indices) return { hasRow: false };
  return captureTodayRowSnapshot(wrapper, indices);
}

function panelIsStale(mount) {
  return (
    !panel.node.isConnected ||
    panel.node.getAttribute(PANEL_READY_ATTR) !== "1" ||
    panel.mode !== mount.mode
  );
}

function buildPanel(mount) {
  const built = createPanel(mount.mode);
  // Insert only as the LAST step. If anything above throws, no half-built
  // panel is ever attached — `panel` stays null and the next sync tries
  // again, instead of leaving a headless card that ensure-present would
  // then treat as "already there" forever.
  mount.container.insertBefore(built.node, mount.reference);
  built.node.setAttribute(PANEL_READY_ATTR, "1");
  panel = { node: built.node, refs: built.refs, mode: mount.mode };
  panelBuildCount += 1;
  document.documentElement.setAttribute(PANEL_BUILDS_ATTR, String(panelBuildCount));
  previousPanelKind = null; // fresh panel — never alert on its first render
  startClock();
}

function sweepOrphanPanels() {
  document.querySelectorAll(`[${PANEL_ATTR}]`).forEach((node) => {
    if (!panel || node !== panel.node) node.remove();
  });
}

/**
 * Idempotent ensure-present: build once, then only refresh text and (if the
 * mount node itself was replaced, e.g. the summary modal reopening) move
 * the existing panel — never tear down and rebuild a working panel, which
 * would reset the running clock every debounce tick. Torn down entirely
 * when off-route, when no mount exists, or when today has no row.
 */
function ensurePanel() {
  if (!ROUTE_RE.test(location.pathname)) {
    teardownPanel();
    return;
  }

  const mount = findSummaryMount();
  if (!mount) {
    teardownPanel();
    return;
  }

  const snapshot = computePanelSnapshot();
  if (snapshot === null) {
    teardownPanel();
    return;
  }
  panelSnapshot = snapshot;

  if (panel && panelIsStale(mount)) {
    teardownPanel();
  }

  if (!panel) {
    buildPanel(mount);
  } else if (panel.node.parentElement !== mount.container || panel.node.nextSibling !== mount.reference) {
    mount.container.insertBefore(panel.node, mount.reference);
  }

  sweepOrphanPanels();
  renderPanelNow();
}

function teardownPanel() {
  stopClock();
  clearTitleAlert();
  previousPanelKind = null;
  baseTitle = null;
  panel?.node.remove();
  panel = null;
  panelSnapshot = null;
  sweepOrphanPanels();
}

/** Recompute the derived state from the latest snapshot + `now`, and paint it. */
function renderPanelNow() {
  if (!panel || !panelSnapshot) return;
  withApplying(() => {
    const state = panelSnapshot.hasRow
      ? derivePanelState({ ...panelSnapshot, now: new Date(), durationMinutes: SAFE_DURATION_MINUTES })
      : { kind: "loading" };
    renderPanel(panel.refs, state);
    updateTitleAlert(state);
  });
}

/**
 * Edge-crossing only, never a level check: alert exactly when the state
 * transitions INTO timeup, never merely because it currently IS timeup.
 * `previousPanelKind === null` guards the first render after every panel
 * (re)build, so reloading the page after the end time has already passed
 * produces no stale alarm — only a live crossing during the session does.
 *
 * There is no state after `timeup` to fall back out of it into (the
 * countdown is frozen, not merely delayed), so once applied the title
 * prefix is re-asserted every tick for the rest of the session — it only
 * clears via clearTitleAlert() on teardown (route leave, mount gone, or the
 * panel being rebuilt). That also means a rebuild (e.g. crossing the
 * rail/modal breakpoint) resets `previousPanelKind` to null and silently
 * suppresses the *next* alert, since the guard above can't tell a fresh
 * build from a resumed session — a known, accepted gap, not a new one.
 */
function updateTitleAlert(state) {
  const wasTimeup = previousPanelKind === "timeup";
  const isTimeup = state.kind === "timeup";

  if (isTimeup && !wasTimeup && previousPanelKind !== null) {
    if (baseTitle === null) baseTitle = document.title;
    document.title = PANEL_TITLE_PREFIX + baseTitle;
    titleAlertActive = true;
  } else if (!isTimeup && titleAlertActive) {
    clearTitleAlert();
  } else if (isTimeup && titleAlertActive) {
    // Re-apply in case something else (an SPA re-render) overwrote it.
    document.title = PANEL_TITLE_PREFIX + baseTitle;
  }

  previousPanelKind = state.kind;
}

function clearTitleAlert() {
  if (titleAlertActive && baseTitle !== null) {
    document.title = baseTitle;
  }
  titleAlertActive = false;
}

function startClock() {
  if (clockTimer) return;
  clockTimer = setInterval(() => {
    // Hidden-tab short-circuit: without this a 1Hz interval keeps rendering
    // for up to 5 minutes behind another window before the browser's own
    // throttling would slow it down (measured — see the plan's research
    // pass). visibilitychange below is what keeps the display from ever
    // being *seen* stale despite the pause.
    if (document.hidden) return;
    renderPanelNow();
  }, PANEL_CLOCK_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

function onVisibilityChange() {
  if (!document.hidden) renderPanelNow();
}

// --- Column + lifecycle ---------------------------------------------------

/**
 * Remove-then-rebuild, never a "does the column already exist" guard. A
 * guard prevents duplicates but never refreshes, and measurement against
 * the live portal showed why that matters: a data refetch (e.g. toggling
 * the Weekends filter) changes the row set in place — new rows arrive
 * without our cell while old rows keep theirs, producing a ragged table
 * that a guard-based early-return would leave permanently broken.
 *
 * The Today panel is intentionally NOT part of this rebuild — see
 * ensurePanel above and CLAUDE.md for why it has the opposite lifecycle.
 */
export function syncAttendance() {
  ensurePanel();

  removeInjected();
  if (!ROUTE_RE.test(location.pathname)) return;

  const wrapper = findTable();
  if (!wrapper) return;

  const indices = computeIndices(getHeaderTexts(wrapper));
  if (!indices) return;

  injectColumn(wrapper, indices.insertAt, makeCellTextFn(indices.srcIdx, indices.endIdx));

  syncCount += 1;
  wrapper.setAttribute("data-cto-syncs", String(syncCount));
  wrapper.querySelector(`th[${MARKER_ATTR}]`)?.setAttribute("data-cto-v", __VERSION__);

  log("synced", { syncCount, target: __TARGET__ });
}

/**
 * Lightweight per-minute refresh of just today's elapsed-time text. Wrapped
 * in withApplying() — the same guard the panel's clock uses — so it can't
 * feed the observer loop the way an un-wrapped textContent write did
 * previously: `textContent` emits a childList mutation record that
 * `Text.data` does not, and an unwrapped write was scheduling a full
 * rebuild 200ms after every tick.
 *
 * This also bounds a real (if narrow) staleness gap: if AntD ever re-renders
 * a row's cell text in place without a childList mutation, our injected
 * value would go stale with no observer callback to catch it. This tick is
 * what caps that at 60 seconds — not just a nicety for the "Xh Ym in" label.
 */
export function tickAttendance() {
  if (!ROUTE_RE.test(location.pathname)) return;
  const wrapper = findTable();
  if (!wrapper) return;

  const indices = computeIndices(getHeaderTexts(wrapper));
  if (!indices) return;
  const cellTextFor = makeCellTextFn(indices.srcIdx, indices.endIdx);

  const today = localDateKey(new Date());
  const rows = wrapper.querySelectorAll(DATA_ROW_SELECTOR);
  withApplying(() => {
    for (const row of rows) {
      if (rowDateFromKey(row.getAttribute("data-row-key") || "") !== today) continue;
      const cell = row.querySelector(`td[${MARKER_ATTR}]`);
      if (cell) cell.textContent = cellTextFor(row);
      break; // exactly one row is "today"
    }
  });
}

/**
 * Called from the burst-guard branch in runSync() (index.js) as well as
 * ordinary teardown paths. If the extension has given up, a 1Hz clock still
 * ticking against a panel permanently detached from its data source is the
 * worst possible failure mode — "quietly stop helping" means ALL of it
 * stops, not just the observer.
 */
export function stopAttendance() {
  stopClock();
  clearTitleAlert();
}
