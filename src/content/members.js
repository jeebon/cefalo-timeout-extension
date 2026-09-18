// The members-directory tracker: policy and lifecycle. Mirrors attendance.js
// — this file decides WHAT the bar should show and WHEN; directory.js only
// knows HOW to find the mount, scrape a card, and paint a view state.
//
// This is the extension's first feature to do asynchronous work (storage
// reads/writes), which is why several rules below don't have a precedent
// elsewhere in the codebase: single-flight writes, an epoch guard against a
// route change mid-write, and a LOCAL burst guard tighter than the shared
// one in index.js, so a bug in this feature can't take the shipped
// attendance column and Today panel down with it.

import {
  findDirectoryMount,
  findMemberCards,
  scrapeCard,
  createDirectoryBar,
  renderDirectoryBar,
} from "./directory.js";
import { emptyStore, applySnap, diffRoster, deleteSnap, buildChangeGroups, migrate, formatSnapTime } from "../lib/roster.js";
import { loadStore, saveStore, clearStore, watchStore } from "../lib/storage.js";
import { MEMBERS_ROUTE_RE, DIR_ATTR, DIR_READY_ATTR, DIR_BUILDS_ATTR, DIR_SNAPS_ATTR, MIN_ABSOLUTE_CARDS } from "../lib/config.js";
import { withApplying } from "./applying.js";
import { warn } from "../lib/log.js";

let bar = null; // { node, refs } | null
let cache = null; // in-memory store snapshot, for PAINTING only — never the base of a diff
let storeLoaded = false;
let unwatch = null;
let epoch = 0; // bumped on teardown; async handlers discard stale results

let dirBuildCount = 0;
let dirSnapCount = 0;

// UI-only state that doesn't belong in storage.
let busy = false;
let error = "";
let changesExpanded = false;
let snapConfirmArmed = false; // user has seen the delta confirm and can now click through
let snapConfirmText = ""; // computed once, when armed — from the SAME diff that decided to arm it
let untrackConfirming = false;
let deleteSnapConfirmIndex = null; // index into cache.snaps pending a delete confirm, or null
// The whole bar collapses under one toggle, collapsed by default — this is
// deliberately session-only (not stored), matching changesExpanded/etc. above:
// it's a view preference, not tracking data, and resets to the calm default
// on every fresh page load rather than accumulating as one more storage field.
let collapsed = true;

// Display-only cap on the "Member changes" list, in SNAPSHOTS (groups), not
// individual events — the full history always stays in storage/export, this
// only bounds how many groups get built into the DOM at once so a
// long-lived tracker with hundreds of snapshots doesn't render them all on
// every expand.
const CHANGE_GROUPS_DISPLAY_CAP = 50;

// Local, tighter burst guard: if OUR OWN rebuilds are thrashing, disable
// only this feature and stop triggering further work — which is also what
// keeps us from ever contributing enough syncs to trip the SHARED guard in
// index.js and take the attendance column down with us. Deliberately a
// smaller window/limit than SYNC_BURST_LIMIT/SYNC_BURST_WINDOW_MS.
const DIR_BURST_LIMIT = 8;
const DIR_BURST_WINDOW_MS = 5_000;
const buildTimestamps = [];
let selfStopped = false;

function isSelfBursting() {
  const now = Date.now();
  buildTimestamps.push(now);
  while (buildTimestamps.length && now - buildTimestamps[0] > DIR_BURST_WINDOW_MS) buildTimestamps.shift();
  return buildTimestamps.length > DIR_BURST_LIMIT;
}

function ensureWatching() {
  if (unwatch) return;
  unwatch = watchStore((store) => {
    cache = store;
    repaint();
  });
}

function stopWatching() {
  unwatch?.();
  unwatch = null;
}

// --- Lifecycle -------------------------------------------------------------

function barIsStale() {
  return !bar.node.isConnected || bar.node.getAttribute(DIR_READY_ATTR) !== "1";
}

function buildBar(mount) {
  if (isSelfBursting()) {
    warn(`directory bar rebuild loop detected (>${DIR_BURST_LIMIT} in ${DIR_BURST_WINDOW_MS}ms) — disabling`);
    selfStopped = true;
    teardownDirectory();
    return;
  }
  const built = createDirectoryBar();
  mount.container.insertBefore(built.node, mount.reference);
  built.node.setAttribute(DIR_READY_ATTR, "1");
  bar = built;
  dirBuildCount += 1;
  document.documentElement.setAttribute(DIR_BUILDS_ATTR, String(dirBuildCount));
  wireHandlers();
  if (!storeLoaded) kickOffLoad();
  ensureWatching();
}

function sweepOrphanBars() {
  document.querySelectorAll(`[${DIR_ATTR}]`).forEach((node) => {
    if (!bar || node !== bar.node) node.remove();
  });
}

/**
 * Idempotent ensure-present, mirroring ensurePanel() in attendance.js:
 * build once, then only move/repaint — never tear down and rebuild a
 * working bar, which would collapse the Member-changes expansion and the
 * selected timeline snap on every debounce tick.
 */
export function syncMembers() {
  if (selfStopped) return;
  if (!MEMBERS_ROUTE_RE.test(location.pathname)) {
    teardownDirectory();
    return;
  }

  const mount = findDirectoryMount();
  if (!mount) {
    teardownDirectory();
    return;
  }

  if (bar && barIsStale()) teardownDirectory();

  if (!bar) {
    buildBar(mount);
    if (!bar) return; // buildBar can self-stop instead of building
  } else if (bar.node.parentElement !== mount.container || bar.node.nextSibling !== mount.reference) {
    mount.container.insertBefore(bar.node, mount.reference);
  }

  sweepOrphanBars();
  repaint();
}

function teardownDirectory() {
  bar?.node.remove();
  bar = null;
  epoch += 1; // discard any in-flight async result targeting the old bar
  stopWatching();
  busy = false;
  error = "";
  changesExpanded = false;
  snapConfirmArmed = false;
  snapConfirmText = "";
  untrackConfirming = false;
  deleteSnapConfirmIndex = null;
  collapsed = true;
}

/** Called from index.js's shared burst-guard branch — a genuine whole-page loop stops everything. */
export function stopMembers() {
  teardownDirectory();
  selfStopped = true;
}

// --- Store loading -----------------------------------------------------

async function kickOffLoad() {
  const myEpoch = epoch;
  const result = await loadStore();
  if (myEpoch !== epoch) return; // route changed / bar torn down while loading
  storeLoaded = true;
  if (result.ok) {
    cache = result.store;
  } else {
    cache = emptyStore();
    error = result.error;
  }
  repaint();
}

// --- Repaint -------------------------------------------------------------

/** One-line status shown in the collapsed head — always visible, so collapsing never hides "is anything happening". */
function summarize() {
  if (!storeLoaded) return "Loading…";
  if (location.search !== "") return "Hidden — filtered view";
  if (!cache || cache.snaps.length === 0) return "Not tracking";
  const latest = cache.snaps[cache.snaps.length - 1];
  return `${latest.total} tracked · last snap ${formatSnapTime(latest.at)}`;
}

function repaint() {
  if (!bar) return;
  withApplying(() => {
    const headSummary = summarize();

    if (!storeLoaded) {
      renderDirectoryBar(bar.refs, { kind: "loading", busy: true, collapsed, headSummary }, formatSnapTime);
      return;
    }

    // A filtered URL means the grid is a SUBSET of the roster, not the whole
    // thing — there is no reliable way to tell "this person is filtered out"
    // apart from "this person left", so the entire feature hides rather than
    // risk recording (or even offering to record) a partial list as history.
    // This is a hard gate on the URL signal specifically, ahead of every
    // other state, including "not tracking" — a first Track click while
    // filtered would bake a wrong baseline in just as badly as a Snap would.
    if (location.search !== "") {
      renderDirectoryBar(bar.refs, { kind: "filtered", collapsed, headSummary }, formatSnapTime);
      return;
    }

    const tracking = cache.snaps.length > 0;
    if (!tracking) {
      renderDirectoryBar(bar.refs, { kind: "not-tracking", busy, collapsed, headSummary }, formatSnapTime);
      return;
    }

    // The grid is only ever READ here — never written to. Every visible
    // consequence of a snap lives inside this bar's "Member changes" list,
    // not on the portal's own cards.
    const cards = findMemberCards();
    const scraped = cards.map(scrapeCard).filter(Boolean);

    // One group per snapshot ever taken, INCLUDING the baseline — that's
    // what makes "where tracking began" visible instead of silently
    // dropped, and what replaces the separate raw snapshot-history list
    // this bar used to show below Member changes.
    const fullGroups = buildChangeGroups(cache);
    const changeGroups = changesExpanded ? fullGroups.slice(0, CHANGE_GROUPS_DISPLAY_CAP) : [];
    const changeGroupsMore = changesExpanded ? Math.max(0, fullGroups.length - CHANGE_GROUPS_DISPLAY_CAP) : 0;
    const changeEventTotal = fullGroups.reduce((n, g) => n + g.events.length, 0);

    // Only valid while cache.snaps still has that index (a delete elsewhere,
    // e.g. another open tab, can invalidate a pending confirm out from under it).
    const deleteTarget =
      deleteSnapConfirmIndex != null && deleteSnapConfirmIndex > 0 && deleteSnapConfirmIndex < cache.snaps.length
        ? cache.snaps[deleteSnapConfirmIndex]
        : null;
    if (deleteSnapConfirmIndex != null && !deleteTarget) deleteSnapConfirmIndex = null;

    renderDirectoryBar(
      bar.refs,
      {
        kind: "tracking",
        busy,
        error,
        collapsed,
        headSummary,
        currentCount: scraped.length,
        changeEventTotal,
        changesExpanded,
        changeGroups,
        changeGroupsMore,
        snapConfirmText: snapConfirmArmed ? snapConfirmText : null,
        deleteSnapConfirmText: deleteTarget
          ? `Delete the snapshot from ${formatSnapTime(deleteTarget.at)}? This cannot be undone.`
          : null,
        untrackConfirming,
      },
      formatSnapTime
    );
  });
}

/**
 * Describes a real, non-empty diff before the user commits it — shown for
 * EVERY snap that would change something (joins, leaves, team
 * reassignments, OR position changes — not only add/remove), never only a
 * shrink; a snap with none of the four never reaches here at all (see
 * doSnap()).
 */
function deltaMessage(added, removed, teamChanges, designationChanges) {
  const parts = [];
  if (added > 0) parts.push(`${added} joined`);
  if (removed > 0) parts.push(`${removed} left`);
  if (teamChanges > 0) parts.push(`${teamChanges} team change${teamChanges === 1 ? "" : "s"}`);
  if (designationChanges > 0) parts.push(`${designationChanges} position change${designationChanges === 1 ? "" : "s"}`);
  return `Record this snapshot? ${parts.join(", ")} since the last one.`;
}

// --- Actions -------------------------------------------------------------

async function withBusy(fn) {
  if (busy) return; // single-flight: a second click while one is in-flight is a no-op
  busy = true;
  repaint();
  const myEpoch = epoch;
  try {
    await fn(myEpoch);
  } finally {
    if (myEpoch === epoch) {
      busy = false;
      repaint();
    }
  }
}

async function doSnap(kind) {
  // Belt for the UI gate in repaint(): the button that triggered this is
  // hidden whenever the list is filtered, but a click can still be in
  // flight from the instant before a filter was typed. Refuse rather than
  // trust the caller.
  if (location.search !== "") {
    error = "Clear filters before tracking — a filtered list isn't the full roster.";
    return;
  }

  const cards = findMemberCards();
  const scraped = cards.map(scrapeCard).filter(Boolean);

  if (scraped.length < MIN_ABSOLUTE_CARDS) {
    error = "Couldn't read the full list — try again.";
    return;
  }

  const fresh = await loadStore();
  if (!fresh.ok) {
    error = fresh.error;
    return;
  }
  const base = fresh.store;

  if (kind === "snap" && !snapConfirmArmed) {
    const { added, removed, teamChanges, designationChanges } = diffRoster(base, scraped);
    if (added.length === 0 && removed.length === 0 && teamChanges.length === 0 && designationChanges.length === 0) {
      // Nothing changed — not a join, a leave, a team reassignment, or a
      // position change — so don't write a snapshot at all, not even a
      // no-op one. The timeline already has a "no change" rendering for
      // when this DID used to happen; refusing outright is simpler and
      // keeps storage from growing on every idle click of the button.
      error = "No changes since the last snapshot — nothing recorded.";
      return;
    }
    snapConfirmArmed = true;
    snapConfirmText = deltaMessage(added.length, removed.length, teamChanges.length, designationChanges.length);
    return; // render the confirm; the next click actually snaps
  }

  const next = applySnap(base, scraped, new Date().toISOString(), kind);
  const saved = await saveStore(next);
  if (!saved.ok) {
    error = saved.error;
    return;
  }
  cache = next;
  error = "";
  snapConfirmArmed = false;
  snapConfirmText = "";
  dirSnapCount += 1;
  document.documentElement.setAttribute(DIR_SNAPS_ATTR, String(dirSnapCount));
}

// `cache` IS already the whole store — every snap ever taken (`snaps[]`)
// and every person ever seen, including present:false former members
// (`people`) — not just who's on screen right now. Exporting it verbatim
// is what makes Import (below) a faithful round-trip: the same object
// `migrate()` already validates on every ordinary storage load.
function exportStore() {
  if (!cache) return;
  const blob = new Blob([JSON.stringify(cache, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cefalo-members-tracking-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Restore a whole history exported from another browser/computer. Only
 * ever reachable from the "not-tracking" state (see createDirectoryBar()),
 * but re-checks that fresh — right before writing, not just at the moment
 * the button was clicked — since the native file picker can stay open for
 * an arbitrary amount of time and tracking could start (e.g. in another
 * tab) while it's up. Refuses outright rather than overwrite anything.
 * @param {File} file
 * @param {number} myEpoch
 */
async function doImport(file, myEpoch) {
  const fresh = await loadStore();
  if (myEpoch !== epoch) return;
  if (!fresh.ok) {
    error = fresh.error;
    return;
  }
  if (fresh.store.snaps.length > 0) {
    error = "Tracking already started — import is only available before you start.";
    return;
  }

  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    error = "Couldn't read that file — is it a tracking export?";
    return;
  }
  if (myEpoch !== epoch) return;

  const imported = migrate(raw);
  if (!imported) {
    error = "That file isn't a tracking export this version recognizes.";
    return;
  }

  const saved = await saveStore(imported);
  if (myEpoch !== epoch) return;
  if (!saved.ok) {
    error = saved.error;
    return;
  }
  cache = imported;
  error = "";
  dirSnapCount += 1;
  document.documentElement.setAttribute(DIR_SNAPS_ATTR, String(dirSnapCount));
}

function wireHandlers() {
  const { refs } = bar;

  refs.head.addEventListener("click", () => {
    collapsed = !collapsed;
    repaint();
  });

  refs.trackBtn.addEventListener("click", () => withBusy(() => doSnap("baseline")));
  refs.snapBtn.addEventListener("click", () => withBusy(() => doSnap("snap")));

  // importBtn's click is the user gesture the browser requires to honor a
  // programmatic file-picker open — it must fire synchronously here, never
  // after an await. The actual read/validate/save work happens in
  // doImport(), triggered by the input's own "change" once a file is
  // picked (or never, if the dialog is cancelled).
  refs.importBtn.addEventListener("click", () => refs.importInput.click());
  refs.importInput.addEventListener("change", () => {
    const file = refs.importInput.files?.[0];
    refs.importInput.value = ""; // reset so picking the SAME file again still fires "change"
    if (!file) return;
    withBusy((myEpoch) => doImport(file, myEpoch));
  });

  refs.changesHeader.addEventListener("click", () => {
    changesExpanded = !changesExpanded;
    repaint();
  });

  refs.untrackBtn.addEventListener("click", () => {
    untrackConfirming = true;
    repaint();
  });
  refs.untrackConfirmNo.addEventListener("click", () => {
    untrackConfirming = false;
    repaint();
  });
  refs.untrackConfirmYes.addEventListener("click", () =>
    withBusy(async (myEpoch) => {
      const result = await clearStore();
      if (myEpoch !== epoch) return;
      if (!result.ok) {
        error = result.error;
        return;
      }
      cache = emptyStore();
      error = "";
      untrackConfirming = false;
      dirSnapCount += 1;
      document.documentElement.setAttribute(DIR_SNAPS_ATTR, String(dirSnapCount));
    })
  );

  refs.snapConfirmNo.addEventListener("click", () => {
    snapConfirmArmed = false;
    snapConfirmText = "";
    repaint();
  });
  refs.snapConfirmYes.addEventListener("click", () => withBusy(() => doSnap("snap")));

  // Delegated: one listener for however many group delete buttons Member
  // changes currently renders, rather than rewiring on every repaint.
  refs.changesList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cto-dir-del-index]");
    if (!btn) return;
    deleteSnapConfirmIndex = Number(btn.dataset.ctoDirDelIndex);
    repaint();
  });
  refs.deleteConfirmNo.addEventListener("click", () => {
    deleteSnapConfirmIndex = null;
    repaint();
  });
  refs.deleteConfirmYes.addEventListener("click", () =>
    withBusy(async (myEpoch) => {
      const index = deleteSnapConfirmIndex;
      if (index == null) return;
      const fresh = await loadStore();
      if (myEpoch !== epoch) return;
      if (!fresh.ok) {
        error = fresh.error;
        return;
      }
      const next = deleteSnap(fresh.store, index);
      const saved = await saveStore(next);
      if (myEpoch !== epoch) return;
      if (!saved.ok) {
        error = saved.error;
        return;
      }
      cache = next;
      error = "";
      deleteSnapConfirmIndex = null;
      dirSnapCount += 1;
      document.documentElement.setAttribute(DIR_SNAPS_ATTR, String(dirSnapCount));
    })
  );

  refs.exportBtn.addEventListener("click", exportStore);
}
