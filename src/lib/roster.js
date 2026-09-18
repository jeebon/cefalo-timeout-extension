// @ts-check
// Pure roster diffing for the members-directory tracker. No DOM, no storage
// — mirrors lib/time.js's role: this is the one thing in this feature worth
// unit testing, and everything else (directory.js, members.js) hands it
// already-scraped data and paints what it returns.

/**
 * Coerce any id (number from a scrape, or a `snaps[].added/removed` entry)
 * to the string key `people` is keyed by. One helper, used everywhere, so
 * `Array.includes`/`Set` membership and JSON round-trips never quietly
 * disagree about number-vs-string.
 * @param {number|string} id
 * @returns {string}
 */
export function personKey(id) {
  return String(id);
}

/** @returns {{v: number, startedAt: null, snaps: Array, people: Object}} */
export function emptyStore() {
  return { v: 1, startedAt: null, snaps: [], people: {} };
}

/**
 * @typedef {{userId: number, name: string, username: string, designation: string, teams: string[], photo: string}} ScrapedPerson
 */

/**
 * Order-insensitive team-list equality. Team order in the DOM reflects the
 * portal's own rendering, not something a person did — comparing sorted
 * copies is what keeps a harmless reorder from being reported as a change.
 * @param {string[]} a
 * @param {string[]} b
 */
function sameTeams(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}

/**
 * Compute the added/removed/teamChanges/designationChanges for one scrape
 * against the current store, WITHOUT mutating anything.
 *
 * `added` includes both brand-new people and rejoiners (`present === false`
 * in the stored record) — a rejoin is not distinguishable from a join by
 * this function, by design: both are things that just started being true
 * again, and both belong in `added`.
 *
 * `teamChanges`/`designationChanges` are checked only for people who are
 * NOT in `added` — a rejoin's team/title is a fresh fact, not a "change"
 * from the nothing that preceded it while they were away, so those buckets
 * are mutually exclusive with `added` by construction. The two are
 * independent of EACH OTHER, though — a promotion that also moves someone
 * to a new team in the same snap produces one entry in each bucket, not a
 * single combined one; simpler to reason about and to test than trying to
 * merge two unrelated kinds of change into one record.
 * @param {ReturnType<typeof emptyStore>} store
 * @param {ScrapedPerson[]} scraped
 * @returns {{added: number[], removed: number[], teamChanges: {id: number, from: string[], to: string[]}[], designationChanges: {id: number, from: string, to: string}[]}}
 */
export function diffRoster(store, scraped) {
  const scrapedIds = new Set(scraped.map((p) => p.userId));
  const added = [];
  const teamChanges = [];
  const designationChanges = [];
  for (const p of scraped) {
    const existing = store.people[personKey(p.userId)];
    if (!existing || existing.present === false) {
      added.push(p.userId);
      continue;
    }
    if (!sameTeams(existing.teams, p.teams)) teamChanges.push({ id: p.userId, from: existing.teams, to: p.teams });
    if (existing.designation !== p.designation) {
      designationChanges.push({ id: p.userId, from: existing.designation, to: p.designation });
    }
  }
  const removed = [];
  for (const [key, person] of Object.entries(store.people)) {
    if (person.present === true && !scrapedIds.has(Number(key))) removed.push(Number(key));
  }
  return { added, removed, teamChanges, designationChanges };
}

/**
 * Apply one snap: upsert every scraped person, flip `present` on anyone who
 * dropped out, and append the snap record. Returns a NEW store (the input is
 * not mutated), matching the rest of this codebase's preference for pure
 * transforms over in-place writes.
 *
 * `kind` is `"baseline"` for the very first snap (Track) and `"snap"` for
 * every one after. A baseline's `added` (and, for the same reason,
 * `teamChanges`/`designationChanges`) is forced to `[]` — it is a starting
 * point, not 257 simultaneous arrivals or changes — even though
 * `diffRoster` would otherwise report every scraped person as added
 * against an empty store.
 *
 * `teamChanges`/`designationChanges` are the ONLY places a person's
 * previous team/title value is ever recorded — `people[key].teams`/
 * `.designation` always hold the latest known value, so these snap-entry
 * fields are the sole historical record of what they used to be, exactly
 * as `removed` + a frozen `present:false` profile already is for "who
 * used to be here".
 *
 * @param {ReturnType<typeof emptyStore>} store
 * @param {ScrapedPerson[]} scraped
 * @param {string} at ISO timestamp
 * @param {"baseline"|"snap"} kind
 */
export function applySnap(store, scraped, at, kind) {
  const {
    added: rawAdded,
    removed,
    teamChanges: rawTeamChanges,
    designationChanges: rawDesignationChanges,
  } = diffRoster(store, scraped);
  const added = kind === "baseline" ? [] : rawAdded;
  const teamChanges = kind === "baseline" ? [] : rawTeamChanges;
  const designationChanges = kind === "baseline" ? [] : rawDesignationChanges;

  const people = { ...store.people };
  const removedSet = new Set(removed);

  for (const p of scraped) {
    const key = personKey(p.userId);
    const existing = people[key];
    people[key] = {
      name: p.name,
      username: p.username,
      designation: p.designation,
      teams: p.teams,
      photo: p.photo,
      firstSeen: existing?.firstSeen ?? at,
      lastSeen: at,
      present: true,
    };
  }
  for (const id of removedSet) {
    const key = personKey(id);
    if (people[key]) people[key] = { ...people[key], present: false };
  }

  const snaps = [...store.snaps, { at, kind, total: scraped.length, added, removed, teamChanges, designationChanges }];

  return {
    ...store,
    startedAt: store.startedAt ?? at,
    snaps,
    people,
  };
}

/**
 * Look up stored profiles for a list of ids (from a snap's `added`/`removed`),
 * skipping any id the store has no record for rather than throwing. Ids may
 * be numbers (as stored in `snaps[]`) or strings — personKey() normalizes.
 * @param {ReturnType<typeof emptyStore>} store
 * @param {(number|string)[]} ids
 */
export function peopleFor(store, ids) {
  return ids
    .map((id) => store.people[personKey(id)])
    .filter(Boolean);
}

/**
 * Everyone currently marked `present: false`. Kept for its own tests even
 * though the "Member changes" UI now builds from `buildChangeGroups()`
 * below instead — still a correct, standalone answer to "who's gone right
 * now".
 * @param {ReturnType<typeof emptyStore>} store
 */
export function formerMembers(store) {
  return Object.values(store.people).filter((p) => p.present === false);
}

/**
 * Find the snap whose `removed` list contains this id — "when did X leave".
 * Searches newest-first so a person who left, rejoined, and left again
 * reports their MOST RECENT departure rather than their first.
 * @param {ReturnType<typeof emptyStore>} store
 * @param {number|string} id
 */
export function lastDepartureSnap(store, id) {
  const target = Number(id);
  for (let i = store.snaps.length - 1; i >= 0; i--) {
    if (store.snaps[i].removed.includes(target)) return store.snaps[i];
  }
  return null;
}

/**
 * @typedef {{type: "added"|"removed"|"team-changed"|"designation-changed", at: string, personId: number, person: object|undefined, from?: string[]|string, to?: string[]|string}} ChangeEvent
 */

/**
 * The individual per-person events ONE snap contributes — shared by
 * `buildChangeFeed` (flattens every snap) and `buildChangeGroups` (keeps
 * each snap's events nested under it). A baseline snap contributes NOTHING
 * (its `added`/`removed`/`teamChanges`/`designationChanges` are always `[]`
 * by construction — see applySnap) — it's a starting point, not an event.
 *
 * `person` is looked up in the CURRENT `store.people` — for `added`/`removed`
 * this is deliberately the same "latest known / frozen at departure" value
 * the old Former-members row already showed. For `team-changed`/
 * `designation-changed`, `from`/`to` are taken verbatim from the snap
 * itself, NOT re-read from `people`, so a later snap changing that person's
 * team or title again doesn't retroactively corrupt this event's own
 * before/after values.
 * @param {ReturnType<typeof emptyStore>} store
 * @param {ReturnType<typeof emptyStore>["snaps"][number]} snap
 * @returns {ChangeEvent[]}
 */
function eventsForSnap(store, snap) {
  const events = [];
  for (const id of snap.removed) {
    events.push({ type: "removed", at: snap.at, personId: id, person: store.people[personKey(id)] });
  }
  for (const id of snap.added) {
    events.push({ type: "added", at: snap.at, personId: id, person: store.people[personKey(id)] });
  }
  for (const tc of snap.teamChanges ?? []) {
    events.push({
      type: "team-changed",
      at: snap.at,
      personId: tc.id,
      person: store.people[personKey(tc.id)],
      from: tc.from,
      to: tc.to,
    });
  }
  for (const dc of snap.designationChanges ?? []) {
    events.push({
      type: "designation-changed",
      at: snap.at,
      personId: dc.id,
      person: store.people[personKey(dc.id)],
      from: dc.from,
      to: dc.to,
    });
  }
  return events;
}

/**
 * Flatten every snap's events into one reverse-chronological feed —
 * kept for callers that just want "every change, in order" with no
 * per-snapshot grouping. The "Member changes" UI itself now renders from
 * `buildChangeGroups` below instead (see its docblock for why).
 * @param {ReturnType<typeof emptyStore>} store
 * @returns {ChangeEvent[]}
 */
export function buildChangeFeed(store) {
  const events = [];
  for (const snap of store.snaps) events.push(...eventsForSnap(store, snap));
  return events.reverse();
}

/**
 * @typedef {{index: number, at: string, kind: "baseline"|"snap", total: number, events: ChangeEvent[]}} ChangeGroup
 */

/**
 * One group per snap — INCLUDING the baseline and any no-change snap, both
 * of which carry an empty `events` array — so the "Member changes" section
 * can show the full history in one place: where tracking began, every
 * snapshot taken since, and (nested under each) exactly who changed and
 * how. This replaces having two separate, disconnected views (a flat
 * per-person feed with no trace of the baseline, plus a separate raw
 * snapshot-history list) with one.
 *
 * `index` is the snap's position in `store.snaps` — NOT the position in
 * this reversed, newest-first result — because that's what a per-snapshot
 * delete operates on (`deleteSnap()`).
 * @param {ReturnType<typeof emptyStore>} store
 * @returns {ChangeGroup[]}
 */
export function buildChangeGroups(store) {
  return store.snaps
    .map((snap, index) => ({ index, at: snap.at, kind: snap.kind, total: snap.total, events: eventsForSnap(store, snap) }))
    .reverse();
}

/**
 * Format a stored ISO-UTC timestamp for display, in the VIEWER's local time
 * — never the raw UTC digits. Printing "18:20:00.000Z" as "18:20" would show
 * a snap taken at 00:20 on the 15th in Dhaka (UTC+6) as 18:20 on the 14th:
 * wrong date AND time. This is the same class of bug localDateKey() in
 * time.js exists to avoid, applied to a timestamp instead of a date key.
 * `Intl.DateTimeFormat` with no `timeZone` option defaults to the runtime's
 * local zone, which is what makes this correct without hand-rolled math.
 * @param {string} iso
 */
export function formatSnapTime(iso) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Validate/upgrade a raw value loaded from storage OR imported from a file
 * a user picked. Identity for the current version; refuses (returns null)
 * anything it doesn't recognize rather than silently reinterpreting a shape
 * it wasn't written for. A future v2 gets a real migration step added here,
 * in front of this check.
 *
 * The shape check (`snaps` an array, `people` an object) matters more than
 * it looks: this function used to only ever see the extension's OWN
 * previously-saved data, where `v === 1` was enough because nothing else
 * could have written a `{v: 1, ...}` object into this storage key. Import
 * hands it an arbitrary user-picked file, a much less trusted input — a
 * hand-edited or truncated file can easily claim `v: 1` while missing
 * `snaps`/`people` entirely, and without this check that garbage would
 * sail through as "valid" and crash the first thing that reads
 * `store.snaps.length`.
 * @param {any} raw
 * @returns {ReturnType<typeof emptyStore>|null}
 */
export function migrate(raw) {
  if (raw == null) return emptyStore();
  if (raw.v === 1 && Array.isArray(raw.snaps) && raw.people != null && typeof raw.people === "object") return raw;
  return null;
}

/**
 * Reconstruct "who was present" after each snap, purely from what's already
 * stored — no snap carries a full roster (only `added`/`removed` deltas), so
 * this replays them. The one gap is the baseline: its `added` is forced to
 * `[]` by design (see applySnap), so the baseline roster is recovered the
 * other way stored data makes it recoverable — anyone whose `firstSeen`
 * equals the baseline's own timestamp was in it, and firstSeen is NEVER
 * rewritten after that first observation, so this stays correct forever
 * regardless of how many times that person has left and rejoined since.
 * @param {ReturnType<typeof emptyStore>} store
 * @returns {Set<number>[]} present-id-set after store.snaps[i], one per snap
 */
function computeTimeline(store) {
  const timeline = [];
  const present = new Set();
  const baselineAt = store.snaps[0]?.at;
  if (baselineAt) {
    for (const [key, p] of Object.entries(store.people)) {
      if (p.firstSeen === baselineAt) present.add(Number(key));
    }
  }
  for (let i = 0; i < store.snaps.length; i++) {
    if (i > 0) {
      for (const id of store.snaps[i].added) present.add(id);
      for (const id of store.snaps[i].removed) present.delete(id);
    }
    timeline.push(new Set(present));
  }
  return timeline;
}

/**
 * Recompute every person's `present`/`firstSeen`/`lastSeen` from a (possibly
 * shortened) snap list, replaying it the same way applySnap's diffRoster
 * calls would have. Only those three fields change — name/username/
 * designation/teams/photo are "latest known value" fields, not tied to which
 * snap surfaced them, so they carry over untouched even for a person whose
 * only appearance was in the deleted snap.
 * @param {ReturnType<typeof emptyStore>} store the ORIGINAL store (for baseline membership + existing profiles)
 * @param {Array} newSnaps the snap list after deletion/merge
 */
function rebuildPeople(store, newSnaps) {
  const present = new Set();
  const firstSeen = {};
  const lastSeen = {};

  const baselineAt = store.snaps[0]?.at;
  if (baselineAt) {
    for (const [key, p] of Object.entries(store.people)) {
      if (p.firstSeen === baselineAt) present.add(Number(key));
    }
  }
  for (const id of present) {
    firstSeen[id] = baselineAt;
    lastSeen[id] = baselineAt;
  }

  for (let i = 1; i < newSnaps.length; i++) {
    const snap = newSnaps[i];
    for (const id of snap.added) present.add(id);
    for (const id of snap.removed) present.delete(id);
    for (const id of present) {
      if (!(id in firstSeen)) firstSeen[id] = snap.at;
      lastSeen[id] = snap.at;
    }
  }

  const people = {};
  for (const [key, p] of Object.entries(store.people)) {
    const id = Number(key);
    if (!(id in firstSeen)) {
      people[key] = p; // never present in the reconstructed timeline — keep the record rather than drop history
      continue;
    }
    people[key] = { ...p, firstSeen: firstSeen[id], lastSeen: lastSeen[id], present: present.has(id) };
  }
  return people;
}

/**
 * Delete one snapshot that is NOT the baseline (index 0) — the baseline is
 * only removable by Untrack (which deletes the whole history), since there
 * is no earlier state to fall back to. Deleting snap[index] merges its
 * transition into whichever snap comes right after it, so that survivor's
 * `added`/`removed` read as "vs two snaps back" instead of referencing a
 * state that no longer exists in the record — everyone's final `present`
 * status is unchanged by this (see computeTimeline's replay), only the
 * recorded SHAPE of how they got there changes for the merged pair.
 * A no-op (returns `store` as-is) for the baseline or an out-of-range index.
 * @param {ReturnType<typeof emptyStore>} store
 * @param {number} index
 */
export function deleteSnap(store, index) {
  const n = store.snaps.length;
  if (!Number.isInteger(index) || index <= 0 || index >= n) return store;

  const timeline = computeTimeline(store);
  const beforeState = timeline[index - 1];

  const newSnaps = store.snaps
    .filter((_, i) => i !== index)
    .map((snap, newPos) => {
      const oldPos = newPos >= index ? newPos + 1 : newPos;
      if (oldPos !== index + 1) return snap; // only the snap right after the gap needs re-deriving
      const afterState = timeline[oldPos];
      return {
        ...snap,
        added: [...afterState].filter((id) => !beforeState.has(id)),
        removed: [...beforeState].filter((id) => !afterState.has(id)),
      };
    });

  return { ...store, snaps: newSnaps, people: rebuildPeople(store, newSnaps) };
}
