// DOM mechanics only for the members-directory tracker bar — no storage, no
// diffing, no policy. Mirrors table.js/panel.js's split: members.js decides
// WHAT to show and WHEN; this file only knows HOW to find the mount, scrape
// a card, and paint a view-state into the bar it built.

import { DIR_ATTR, DIR_READY_ATTR } from "../lib/config.js";

const AVATAR_SELECTOR = 'img[src*="/api/avatars/"]';
const PROFILE_LINK_SELECTOR = 'a[href^="/profile/view/?id="]';

/**
 * Every non-header avatar image on the page — the one count this whole
 * module anchors on instead of any Tailwind class, which the grid's own
 * class (`grid w-full grid-cols-2 gap-2 sm:grid-cols-[...]`) is exactly the
 * kind of string that gets rewritten on a layout tweak.
 */
function nonHeaderAvatarImgs() {
  return [...document.querySelectorAll(AVATAR_SELECTOR)].filter(
    (img) => !img.closest("header"),
  );
}

/**
 * The smallest ancestor of one avatar img that also contains that person's
 * profile link and no OTHER avatar — i.e. exactly one member's card,
 * regardless of how many wrapper divs the portal nests it in. Returns null
 * if no such ancestor exists within a reasonable climb (malformed markup).
 * @param {Element} img
 */
function cardFor(img) {
  let node = img;
  for (let i = 0; i < 8 && node; i++) {
    if (
      node.querySelector(PROFILE_LINK_SELECTOR) &&
      node.querySelectorAll(AVATAR_SELECTOR).length === 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** @returns {Element[]} one element per member card currently rendered */
export function findMemberCards() {
  const seen = new Set();
  const cards = [];
  for (const img of nonHeaderAvatarImgs()) {
    const card = cardFor(img);
    if (card && !seen.has(card)) {
      seen.add(card);
      cards.push(card);
    }
  }
  return cards;
}

/**
 * Scrape one card by what it semantically contains, never by paragraph
 * index — one member renders 3 `<p>` instead of 4 (empty teams), and
 * positionally "teams missing" and "designation missing" are
 * indistinguishable, which would file a designation into the teams field.
 * Returns null (an explicit bail, matching computeIndices()'s -1 pattern)
 * if the card doesn't have what identity requires.
 * @param {Element} card
 * @returns {{userId:number, name:string, username:string, designation:string, teams:string[], photo:string}|null}
 */
export function scrapeCard(card) {
  const link = card.querySelector(PROFILE_LINK_SELECTOR);
  if (!link) return null;

  let userId;
  try {
    const b64 =
      new URL(link.getAttribute("href"), location.origin).searchParams.get(
        "id",
      ) || "";
    userId = Number(atob(b64.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null; // malformed href — skip this one card, not the whole scrape
  }
  if (!Number.isFinite(userId)) return null;

  const nameEl = link.querySelector("p");
  const name = nameEl ? nameEl.textContent.trim() : "";
  if (!name) return null;

  const paragraphs = [...card.querySelectorAll("p")].filter(
    (p) => !link.contains(p),
  );
  const usernameIdx = paragraphs.findIndex((p) =>
    p.textContent.trim().startsWith("@"),
  );
  const username =
    usernameIdx >= 0 ? paragraphs[usernameIdx].textContent.trim() : "";
  const rest =
    usernameIdx >= 0 ? paragraphs.slice(usernameIdx + 1) : paragraphs;
  const designation = rest[0] ? rest[0].textContent.trim() : "";
  const teams = rest[1]
    ? rest[1].textContent
        .trim()
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const img = card.querySelector(AVATAR_SELECTOR);
  const photo = img ? img.src : "";

  return { userId, name, username, designation, teams, photo };
}

/**
 * The filter region is always present regardless of result count — anchoring
 * on "the parent of N member cards" instead breaks exactly when the bar is
 * needed most: filtering to 0 or a handful of matches removes that anchor,
 * so a bar meant to say "Clear filters to snap" disappears along with it.
 *
 * Locates the visible "Search Name" input, climbs to the smallest ancestor
 * that also contains the member grid, and returns that ancestor plus the
 * specific child to insert the bar before. Bails on `<body>`/`<html>` (the
 * page header holds the user's own profile link, which would otherwise let
 * the grid-side climb escape the content area entirely).
 * @returns {{container: Element, reference: Element}|null}
 */
export function findDirectoryMount() {
  const avatarImgs = nonHeaderAvatarImgs();
  if (!avatarImgs.length) return null;

  // Climb from one avatar until the ancestor's own avatar count covers every
  // non-header avatar on the page — the smallest container holding the
  // whole grid, whatever its actual class names are.
  let gridNode = avatarImgs[0];
  for (let i = 0; i < 12 && gridNode; i++) {
    if (gridNode.querySelectorAll(AVATAR_SELECTOR).length === avatarImgs.length)
      break;
    gridNode = gridNode.parentElement;
  }
  if (!gridNode) return null;

  const searchInput = [
    ...document.querySelectorAll('input[placeholder="Search Name"]'),
  ].find((el) => el.offsetParent !== null);
  if (!searchInput) return null;

  // Walk up from the grid until we find the ancestor that also contains the
  // search input — that's the shared container both regions live in.
  let root = gridNode;
  while (root && !root.contains(searchInput)) root = root.parentElement;
  if (!root || root === document.body || root === document.documentElement)
    return null;

  // The specific child of `root` that is (or contains) the grid — insert
  // the bar as ITS previous sibling, not as a sibling of the grid itself,
  // so the bar sits above any filter chrome the portal renders alongside it.
  // This climb assumes gridNode is a PROPER descendant of root, which is
  // normally true (root is found by climbing FROM gridNode) — except when
  // a narrow result set (measured live: selecting a Skills filter) collapses
  // the grid container and the filter-region container into the SAME node,
  // i.e. root === gridNode. In that case there's no distinct child to insert
  // before, and the naive climb runs past <html> and reads .parentElement of
  // null. Bail to null (findDirectoryMount's normal "no safe mount" signal,
  // already handled by syncMembers() as teardown) instead of throwing.
  let reference = gridNode;
  while (
    reference &&
    reference.parentElement &&
    reference.parentElement !== root
  ) {
    reference = reference.parentElement;
  }
  if (!reference || reference.parentElement !== root) return null;

  return { container: root, reference };
}

// --- Bar construction ------------------------------------------------------

/**
 * Build the bar DOM once, fully detached — same discipline as panel.js's
 * createPanel(): the caller inserts it only after this returns, and stamps
 * DIR_READY_ATTR only as the last step, so a throw partway through never
 * leaves a half-built bar that ensure-present would mistake for working.
 * @returns {{node: Element, refs: object}}
 */
export function createDirectoryBar() {
  const node = document.createElement("div");
  node.setAttribute(DIR_ATTR, "1");
  node.className = "cto-dir";

  // The whole bar is collapsible, collapsed by default (see members.js) — a
  // click anywhere on the head toggles it. The head itself always stays
  // visible so there's always something to click back open; everything
  // else lives in `body`, one single element to hide/show.
  const head = document.createElement("button");
  head.type = "button";
  head.className = "cto-dir-head";
  const title = document.createElement("span");
  title.className = "cto-dir-head-title";
  title.textContent = "Member tracking";
  const headSummary = document.createElement("span");
  headSummary.className = "cto-dir-head-summary";
  const chevron = document.createElement("span");
  chevron.className = "cto-dir-chevron";
  chevron.textContent = "▾";
  chevron.setAttribute("aria-hidden", "true");
  head.append(title, headSummary, chevron);

  const body = document.createElement("div");
  body.className = "cto-dir-body";

  // Not-tracking view — Track starts fresh; Import restores a history
  // exported from another browser/computer. Import is only ever offered
  // here, in the SAME branch as Track — "not tracking yet" and "nothing to
  // overwrite" are the same condition in this data model (a person only
  // ever enters `people` via applySnap, which always appends a snap), so
  // there is no separate flag to keep in sync with this visibility rule.
  const trackRow = document.createElement("div");
  trackRow.className = "cto-dir-track-row";
  const trackButtons = document.createElement("div");
  trackButtons.className = "cto-dir-track-buttons";
  const trackBtn = document.createElement("button");
  trackBtn.type = "button";
  trackBtn.className = "cto-dir-btn cto-dir-btn-primary";
  trackBtn.textContent = "Track";
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "cto-dir-btn";
  importBtn.textContent = "Import";
  // Hidden — triggered programmatically by importBtn's own click handler
  // (a real user gesture, so the browser honors the file-picker open).
  // Reading a user-picked local file this way needs no extra manifest
  // permission; it's unrelated to host_permissions/storage.
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = "application/json";
  importInput.hidden = true;
  trackButtons.append(trackBtn, importBtn);
  const trackHint = document.createElement("p");
  trackHint.className = "cto-dir-hint";
  trackHint.textContent =
    "Records the current list so you can see who joins or leaves later.";
  const importHint = document.createElement("p");
  importHint.className = "cto-dir-hint";
  importHint.textContent =
    "Or Import a file exported from another browser or computer to restore your history here.";
  trackRow.append(trackButtons, trackHint, importHint, importInput);

  // Tracking view — Member changes: the FULL history, one group per
  // snapshot ever taken (see roster.js#buildChangeGroups) — replaces both
  // the earlier Former-members-only strip AND the separate raw "Timeline"
  // section that used to sit below this one. Each group's header is the
  // same "when + what happened" line the old Timeline rows showed
  // ("Started tracking · N people", "+2 −1 · 1 team change", "no change"),
  // now also the visible marker of where tracking began — a group is shown
  // for EVERY snap, baseline included, even though the baseline itself has
  // no individual join/leave/team-change rows nested under it. There is no
  // separate collapsed thumbnail row — a thumbnail alone doesn't
  // distinguish three event types — so the header (with a running count)
  // is the only collapsed view, expanding straight into the full grouped
  // history.
  const changesSection = document.createElement("div");
  changesSection.className = "cto-dir-changes";
  const changesHeader = document.createElement("button");
  changesHeader.type = "button";
  changesHeader.className = "cto-dir-changes-header";
  const changesHeaderText = document.createTextNode("Changes history (0)");
  changesHeader.appendChild(changesHeaderText);
  const changesList = document.createElement("div");
  changesList.className = "cto-dir-changes-list";
  changesList.hidden = true;
  changesSection.append(changesHeader, changesList);

  // Tracking view — action row
  const actionRow = document.createElement("div");
  actionRow.className = "cto-dir-action-row";
  const snapBtn = document.createElement("button");
  snapBtn.type = "button";
  snapBtn.className = "cto-dir-btn cto-dir-btn-primary";
  const untrackBtn = document.createElement("button");
  untrackBtn.type = "button";
  untrackBtn.className = "cto-dir-btn cto-dir-btn-danger";
  untrackBtn.textContent = "Untrack";
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "cto-dir-btn";
  exportBtn.textContent = "Export";
  actionRow.append(snapBtn, untrackBtn, exportBtn);

  // Untrack confirm (two-step, never window.confirm — that blocks the SPA)
  const untrackConfirm = document.createElement("div");
  untrackConfirm.className = "cto-dir-confirm";
  untrackConfirm.hidden = true;
  const untrackConfirmText = document.createElement("span");
  untrackConfirmText.textContent =
    "Delete all tracking history? This cannot be undone.";
  const untrackConfirmYes = document.createElement("button");
  untrackConfirmYes.type = "button";
  untrackConfirmYes.className = "cto-dir-btn cto-dir-btn-danger";
  untrackConfirmYes.textContent = "Delete";
  const untrackConfirmNo = document.createElement("button");
  untrackConfirmNo.type = "button";
  untrackConfirmNo.className = "cto-dir-btn";
  untrackConfirmNo.textContent = "Cancel";
  untrackConfirm.append(
    untrackConfirmText,
    untrackConfirmYes,
    untrackConfirmNo,
  );

  // Snap delta confirm — states exactly what it's about to record (who
  // joined, who left) instead of saving silently. Shown for EVERY snap that
  // would actually change something; a snap with no change is refused
  // outright before this ever renders (see members.js#doSnap).
  const snapConfirm = document.createElement("div");
  snapConfirm.className = "cto-dir-confirm";
  snapConfirm.hidden = true;
  const snapConfirmText = document.createElement("span");
  const snapConfirmYes = document.createElement("button");
  snapConfirmYes.type = "button";
  snapConfirmYes.className = "cto-dir-btn cto-dir-btn-primary";
  snapConfirmYes.textContent = "Save snapshot";
  const snapConfirmNo = document.createElement("button");
  snapConfirmNo.type = "button";
  snapConfirmNo.className = "cto-dir-btn";
  snapConfirmNo.textContent = "Cancel";
  snapConfirm.append(snapConfirmText, snapConfirmYes, snapConfirmNo);

  // Delete-one-snapshot confirm. Never offered for the baseline (index 0,
  // see the "✕" omission in changeGroupHeader below) — that one is only
  // removable via Untrack, which deletes the whole history at once.
  const deleteConfirm = document.createElement("div");
  deleteConfirm.className = "cto-dir-confirm";
  deleteConfirm.hidden = true;
  const deleteConfirmText = document.createElement("span");
  const deleteConfirmYes = document.createElement("button");
  deleteConfirmYes.type = "button";
  deleteConfirmYes.className = "cto-dir-btn cto-dir-btn-danger";
  deleteConfirmYes.textContent = "Delete";
  const deleteConfirmNo = document.createElement("button");
  deleteConfirmNo.type = "button";
  deleteConfirmNo.className = "cto-dir-btn";
  deleteConfirmNo.textContent = "Cancel";
  deleteConfirm.append(deleteConfirmText, deleteConfirmYes, deleteConfirmNo);

  const errorText = document.createElement("p");
  errorText.className = "cto-dir-error";
  errorText.hidden = true;

  // Shown INSTEAD of everything else whenever the URL carries a filter — a
  // filtered grid is a subset of the roster, and there is no reliable way
  // to tell "filtered out" apart from "left", so the whole feature steps
  // aside rather than risk recording a partial list as history.
  const filteredMessage = document.createElement("p");
  filteredMessage.className = "cto-dir-hint";
  filteredMessage.textContent =
    "Clear filters to use tracking — a filtered list isn't the full roster.";
  filteredMessage.hidden = true;

  body.append(
    filteredMessage,
    trackRow,
    changesSection,
    actionRow,
    untrackConfirm,
    snapConfirm,
    deleteConfirm,
    errorText,
  );
  node.append(head, body);

  return {
    node,
    refs: {
      root: node,
      head,
      headSummary,
      body,
      filteredMessage,
      trackRow,
      trackBtn,
      importBtn,
      importInput,
      changesSection,
      changesHeader,
      changesHeaderText,
      changesList,
      actionRow,
      snapBtn,
      untrackBtn,
      exportBtn,
      untrackConfirm,
      untrackConfirmYes,
      untrackConfirmNo,
      snapConfirm,
      snapConfirmText,
      snapConfirmYes,
      snapConfirmNo,
      deleteConfirm,
      deleteConfirmText,
      deleteConfirmYes,
      deleteConfirmNo,
      errorText,
    },
  };
}

function thumb(person) {
  const img = document.createElement("img");
  img.className = "cto-dir-thumb";
  img.src = person.photo;
  img.alt = person.name;
  img.loading = "lazy";
  // Broken-image fallback: initials on a plain circle. The portal is not
  // guaranteed to keep serving a departed person's avatar (unverified —
  // see the plan's open measurements), so this is the expected path for
  // former members, not an edge case.
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(initialsCircle(person.name));
    },
    { once: true },
  );
  return img;
}

function initialsCircle(name) {
  const el = document.createElement("div");
  el.className = "cto-dir-thumb cto-dir-thumb-fallback";
  el.textContent = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return el;
}

/** @param {string[]} teams */
function formatTeams(teams) {
  return teams.length ? teams.join(", ") : "No team";
}

/** @param {string} designation */
function formatDesignation(designation) {
  return designation || "No title";
}

/**
 * One row of the "Member changes" list — one join, leave or team
 * reassignment, labeled by type. `event.person` can be `undefined` in
 * principle (a malformed/partial store) — every field reads through an
 * optional chain so a missing profile renders blanks rather than throwing.
 *
 * The label sits INLINE right after the name, in brackets, rather than
 * pushed to the far right of the row — a far-right label makes the eye
 * travel the full row width just to tell added from removed, which is
 * exactly the "difficult to trace" complaint this addresses. No date is
 * rendered per row either: the enclosing group header (see changeGroup()
 * below) already carries this event's timestamp once, so repeating it on
 * every row would be redundant, not just noisy.
 *
 * Only the bracketed label itself is colored, never the whole row/name —
 * tinting every value (name, meta, thumbnail) would fight the "trace
 * quickly" goal instead of serving it, and a red/green PAGE BACKGROUND for
 * hundreds of potential rows would be far louder than this bar's existing
 * minimal, text-colored language (`.cto-dir-error`/`.cto-dir-btn-danger`
 * already use colored TEXT on a plain white row, never a tinted
 * background) — colored text on just the label keeps that consistent.
 * @param {import("../lib/roster.js").ChangeEvent} event
 */
function changeRow(event) {
  const row = document.createElement("div");
  row.className = "cto-dir-change-row";
  row.append(thumb(event.person ?? { photo: "", name: "" }));

  const info = document.createElement("div");
  info.className = "cto-dir-change-info";

  const LABEL_TEXT = {
    added: "(Added)",
    removed: "(Removed)",
    "team-changed": "(Team changed)",
    "designation-changed": "(Position changed)",
  };

  const nameEl = document.createElement("div");
  nameEl.className = "cto-dir-change-name";
  nameEl.append(document.createTextNode(`${event.person?.name ?? "Unknown"} `));
  const label = document.createElement("span");
  label.className = `cto-dir-change-label cto-dir-change-label--${event.type}`;
  label.textContent = LABEL_TEXT[event.type];
  nameEl.append(label);

  const metaEl = document.createElement("div");
  metaEl.className = "cto-dir-change-meta";
  if (event.type === "team-changed") {
    metaEl.textContent = `${formatTeams(event.from)} → ${formatTeams(event.to)}`;
  } else if (event.type === "designation-changed") {
    metaEl.textContent = `${formatDesignation(event.from)} → ${formatDesignation(event.to)}`;
  } else {
    metaEl.textContent = [
      event.person?.designation,
      event.person?.teams?.join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  info.append(nameEl, metaEl);
  row.append(info);
  return row;
}

/**
 * The same "when + what happened" text every snapshot has always shown
 * (originally the standalone Timeline's row text; now this group's own
 * header) — kept as one function so the wording can't drift between what
 * used to be two places.
 * @param {import("../lib/roster.js").ChangeGroup} group
 */
function changeGroupSummary(group) {
  if (group.kind === "baseline")
    return `Started tracking · ${group.total} people`;
  const added = group.events.filter((e) => e.type === "added").length;
  const removed = group.events.filter((e) => e.type === "removed").length;
  const teamChanges = group.events.filter(
    (e) => e.type === "team-changed",
  ).length;
  const designationChanges = group.events.filter(
    (e) => e.type === "designation-changed",
  ).length;
  if (
    added === 0 &&
    removed === 0 &&
    teamChanges === 0 &&
    designationChanges === 0
  )
    return "no change";
  const parts = [];
  if (teamChanges)
    parts.push(`${teamChanges} team change${teamChanges === 1 ? "" : "s"}`);
  if (designationChanges)
    parts.push(
      `${designationChanges} position change${designationChanges === 1 ? "" : "s"}`,
    );
  const extra = parts.length ? ` · ${parts.join(" · ")}` : "";
  return `+${added} −${removed}${extra}`;
}

/**
 * One snapshot's worth of the "Member changes" list: a header naming when
 * it was taken and what happened (identical wording to the old standalone
 * Timeline row this replaces), plus that snapshot's own events nested
 * underneath — none, for the baseline or a no-change snap, which is what
 * makes the baseline's header double as the "beginning of history" marker
 * rather than an empty gap.
 * @param {import("../lib/roster.js").ChangeGroup} group
 * @param {(iso:string)=>string} formatLocal
 */
function changeGroup(group, formatLocal) {
  const wrap = document.createElement("div");
  wrap.className = "cto-dir-change-group";

  const header = document.createElement("div");
  header.className = "cto-dir-change-group-header";
  const when = document.createElement("span");
  when.className = "cto-dir-change-group-when";
  when.textContent = formatLocal(group.at);
  const summary = document.createElement("span");
  summary.className = "cto-dir-change-group-summary";
  summary.textContent = changeGroupSummary(group);
  header.append(when, summary);
  // The baseline (index 0) has no delete button — it's only removable via
  // Untrack, which clears the whole history at once (see roster.js#deleteSnap).
  if (group.index > 0) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "cto-dir-change-group-del";
    del.title = "Delete this snapshot";
    del.textContent = "✕";
    del.dataset.ctoDirDelIndex = String(group.index);
    header.append(del);
  }
  wrap.append(header);

  for (const event of group.events) wrap.append(changeRow(event));
  return wrap;
}

/**
 * Paint a fully-derived view state into an existing bar's refs. Every branch
 * here is infrequent (a user click or a storage change), never a per-second
 * repaint, so plain textContent/hidden writes are fine — the Text.data
 * discipline in attendance.js exists for a 1Hz clock, not for this. The
 * caller is still responsible for wrapping this in withApplying(), same as
 * every other write this extension makes to its own injected subtree.
 * @param {object} refs
 * @param {object} state
 * @param {(iso:string)=>string} formatLocal
 */
export function renderDirectoryBar(refs, state, formatLocal) {
  refs.root.dataset.ctoDirState = state.kind;

  // The bar is collapsible independent of everything else below — the head
  // (title + summary + chevron) always stays visible; `body` is the single
  // element that hides the rest, in every kind including "filtered" and
  // "loading". Defaults to collapsed (see members.js), so most page loads
  // never build the rest of this DOM into view at all.
  refs.root.dataset.ctoDirCollapsed = state.collapsed ? "1" : "0";
  refs.head.setAttribute("aria-expanded", String(!state.collapsed));
  refs.headSummary.textContent = state.headSummary || "";
  refs.body.hidden = !!state.collapsed;

  // "filtered" hides EVERYTHING else — Track, Snap/Untrack, Member changes,
  // even a pending error — because none of it is trustworthy against a
  // subset of the roster. This check comes first so nothing below has to
  // separately remember to also check for it.
  refs.filteredMessage.hidden = state.kind !== "filtered";
  if (state.kind === "filtered") {
    refs.trackRow.hidden = true;
    refs.changesSection.hidden = true;
    refs.actionRow.hidden = true;
    refs.untrackConfirm.hidden = true;
    refs.snapConfirm.hidden = true;
    refs.deleteConfirm.hidden = true;
    refs.errorText.hidden = true;
    refs.changesList.innerHTML = "";
    return;
  }

  refs.trackRow.hidden = state.kind !== "not-tracking";
  refs.trackBtn.disabled = state.kind === "not-tracking" && state.busy;
  refs.importBtn.disabled = state.kind === "not-tracking" && state.busy;

  const tracking = state.kind === "tracking";
  refs.changesSection.hidden = !tracking;
  refs.actionRow.hidden = !tracking;

  refs.errorText.hidden = !state.error;
  refs.errorText.textContent = state.error || "";

  if (tracking) {
    refs.snapBtn.disabled = state.busy;
    refs.untrackBtn.disabled = state.busy;
    refs.exportBtn.disabled = state.busy;
    refs.snapBtn.textContent = `Snap · ${state.currentCount} people`;

    refs.changesHeaderText.data = `Member changes (${state.changeEventTotal})`;
    refs.changesList.hidden = !state.changesExpanded;
    if (state.changesExpanded) {
      refs.changesList.innerHTML = "";
      // Already newest-first, index preserved per group — see
      // roster.js#buildChangeGroups. The oldest group (the baseline) is
      // what shows up last here, which is what makes it "the beginning" of
      // this history rather than an unmarked gap.
      for (const group of state.changeGroups)
        refs.changesList.appendChild(changeGroup(group, formatLocal));
      if (state.changeGroupsMore > 0) {
        const more = document.createElement("div");
        more.className = "cto-dir-changes-more";
        more.textContent = `+${state.changeGroupsMore} earlier snapshot${state.changeGroupsMore === 1 ? "" : "s"}`;
        refs.changesList.appendChild(more);
      }
    }
  } else {
    refs.changesList.innerHTML = "";
  }

  refs.snapConfirm.hidden = !state.snapConfirmText;
  if (state.snapConfirmText)
    refs.snapConfirmText.textContent = state.snapConfirmText;

  refs.deleteConfirm.hidden = !state.deleteSnapConfirmText;
  if (state.deleteSnapConfirmText)
    refs.deleteConfirmText.textContent = state.deleteSnapConfirmText;

  refs.untrackConfirm.hidden = !state.untrackConfirming;
}
