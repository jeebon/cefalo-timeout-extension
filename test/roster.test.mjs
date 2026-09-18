import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyStore,
  diffRoster,
  applySnap,
  deleteSnap,
  peopleFor,
  formerMembers,
  lastDepartureSnap,
  buildChangeFeed,
  buildChangeGroups,
  personKey,
  formatSnapTime,
  migrate,
} from "../src/lib/roster.js";

function person(userId, overrides = {}) {
  return {
    userId,
    name: `Person ${userId}`,
    username: `@p${userId}`,
    designation: "Software Engineer",
    teams: ["Snapper"],
    photo: `https://hrportal.cefalolab.com/api/avatars/${userId}.jpg`,
    ...overrides,
  };
}

const T0 = "2026-09-14T12:00:00.000Z";
const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-15T09:00:00.000Z";

test("baseline snap records everyone, sets firstSeen, and yields added:[] with kind:'baseline'", () => {
  const store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  assert.equal(store.snaps.length, 1);
  assert.equal(store.snaps[0].kind, "baseline");
  assert.deepEqual(store.snaps[0].added, []);
  assert.deepEqual(store.snaps[0].removed, []);
  assert.equal(store.snaps[0].total, 2);
  assert.equal(store.people["1"].firstSeen, T0);
  assert.equal(store.people["2"].firstSeen, T0);
  assert.equal(store.people["1"].present, true);
});

test("a joiner lands in added and gets firstSeen", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1), person(2)], T1, "snap");
  assert.deepEqual(store.snaps[1].added, [2]);
  assert.deepEqual(store.snaps[1].removed, []);
  assert.equal(store.people["2"].firstSeen, T1);
});

test("a leaver lands in removed, gets present:false, and their profile is retained for display", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap");
  assert.deepEqual(store.snaps[1].removed, [2]);
  assert.equal(store.people["2"].present, false);
  assert.equal(store.people["2"].name, "Person 2"); // retained, not deleted
});

test("a rejoin lands in added again, sets present:true, and preserves the original firstSeen", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  store = applySnap(store, [person(1), person(2)], T2, "snap"); // 2 rejoins
  assert.deepEqual(store.snaps[2].added, [2]);
  assert.equal(store.people["2"].present, true);
  assert.equal(store.people["2"].firstSeen, T0); // NOT T2 — first observed, not this join
});

test("a team reassignment lands in diffRoster's teamChanges with the correct from/to, and is recorded on the snap", () => {
  let store = applySnap(emptyStore(), [person(1, { teams: ["Alpha"] })], T0, "baseline");
  const { teamChanges } = diffRoster(store, [person(1, { teams: ["Beta"] })]);
  assert.deepEqual(teamChanges, [{ id: 1, from: ["Alpha"], to: ["Beta"] }]);

  store = applySnap(store, [person(1, { teams: ["Beta"] })], T1, "snap");
  assert.deepEqual(store.snaps[1].teamChanges, [{ id: 1, from: ["Alpha"], to: ["Beta"] }]);
  // the person's OWN record always holds the latest value, not the diff
  assert.deepEqual(store.people["1"].teams, ["Beta"]);
});

test("no team change between snaps yields teamChanges: []", () => {
  let store = applySnap(emptyStore(), [person(1, { teams: ["Alpha"] })], T0, "baseline");
  store = applySnap(store, [person(1, { teams: ["Alpha"] })], T1, "snap");
  assert.deepEqual(store.snaps[1].teamChanges, []);
});

test("a team-order reshuffle alone (same set, different array order) is NOT a team change", () => {
  let store = applySnap(emptyStore(), [person(1, { teams: ["Alpha", "Beta"] })], T0, "baseline");
  const { teamChanges } = diffRoster(store, [person(1, { teams: ["Beta", "Alpha"] })]);
  assert.deepEqual(teamChanges, []);
});

test("a rejoin never also produces a teamChanges entry, even with a different team than before leaving", () => {
  let store = applySnap(emptyStore(), [person(1), person(2, { teams: ["Alpha"] })], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  const { added, teamChanges } = diffRoster(store, [person(1), person(2, { teams: ["Beta"] })]); // 2 rejoins with a new team
  assert.deepEqual(added, [2]);
  assert.deepEqual(teamChanges, []); // belongs in added only, not also flagged as a team change
});

test("a baseline snap forces teamChanges to [] even though the store already has differing team data", () => {
  // Cannot arise from diffRoster against emptyStore() (nothing pre-exists to
  // differ from), but applySnap's own force-to-[] for kind:'baseline' must
  // hold regardless of what diffRoster would have reported.
  const store = applySnap(emptyStore(), [person(1, { teams: ["Alpha"] })], T0, "baseline");
  assert.deepEqual(store.snaps[0].teamChanges, []);
});

test("a designation (position) change lands in diffRoster's designationChanges with the correct from/to, and is recorded on the snap", () => {
  let store = applySnap(emptyStore(), [person(1, { designation: "Senior Software Engineer" })], T0, "baseline");
  const { designationChanges } = diffRoster(store, [person(1, { designation: "Staff Software Engineer" })]);
  assert.deepEqual(designationChanges, [{ id: 1, from: "Senior Software Engineer", to: "Staff Software Engineer" }]);

  store = applySnap(store, [person(1, { designation: "Staff Software Engineer" })], T1, "snap");
  assert.deepEqual(store.snaps[1].designationChanges, [
    { id: 1, from: "Senior Software Engineer", to: "Staff Software Engineer" },
  ]);
  // the person's OWN record always holds the latest value, not the diff
  assert.equal(store.people["1"].designation, "Staff Software Engineer");
});

test("no designation change between snaps yields designationChanges: []", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap");
  assert.deepEqual(store.snaps[1].designationChanges, []);
});

test("a rejoin never also produces a designationChanges entry, even with a different title than before leaving", () => {
  let store = applySnap(emptyStore(), [person(1), person(2, { designation: "Engineer" })], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  const { added, designationChanges } = diffRoster(store, [person(1), person(2, { designation: "Senior Engineer" })]); // 2 rejoins with a new title
  assert.deepEqual(added, [2]);
  assert.deepEqual(designationChanges, []); // belongs in added only, not also flagged as a designation change
});

test("a baseline snap forces designationChanges to [] even though the store already has a differing value", () => {
  const store = applySnap(emptyStore(), [person(1, { designation: "Engineer" })], T0, "baseline");
  assert.deepEqual(store.snaps[0].designationChanges, []);
});

test("a team change and a designation change on the SAME person in the SAME snap both record independently", () => {
  let store = applySnap(emptyStore(), [person(1, { teams: ["Alpha"], designation: "Engineer" })], T0, "baseline");
  store = applySnap(store, [person(1, { teams: ["Beta"], designation: "Senior Engineer" })], T1, "snap");
  assert.deepEqual(store.snaps[1].teamChanges, [{ id: 1, from: ["Alpha"], to: ["Beta"] }]);
  assert.deepEqual(store.snaps[1].designationChanges, [{ id: 1, from: "Engineer", to: "Senior Engineer" }]);
});

test("buildChangeFeed returns newest-first, skips the baseline, and freezes team-changed from/to against later overwrites", () => {
  let store = applySnap(emptyStore(), [person(1, { teams: ["Alpha"] })], T0, "baseline");
  store = applySnap(store, [person(1, { teams: ["Beta"] })], T1, "snap"); // Alpha -> Beta
  store = applySnap(store, [person(1, { teams: ["Gamma"] })], T2, "snap"); // Beta -> Gamma

  const feed = buildChangeFeed(store);
  assert.equal(feed.length, 2); // baseline contributes nothing
  assert.deepEqual(
    feed.map((e) => e.at),
    [T2, T1] // newest first
  );
  assert.equal(feed[1].type, "team-changed");
  assert.deepEqual(feed[1].from, ["Alpha"]);
  assert.deepEqual(feed[1].to, ["Beta"]); // NOT corrupted by the later Beta->Gamma snap
  assert.deepEqual(feed[0].from, ["Beta"]);
  assert.deepEqual(feed[0].to, ["Gamma"]);
  // the person's current profile has moved on to the latest value
  assert.deepEqual(store.people["1"].teams, ["Gamma"]);
});

test("buildChangeFeed's removed event carries the frozen-at-departure profile", () => {
  let store = applySnap(emptyStore(), [person(1), person(2, { designation: "Designer" })], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  const feed = buildChangeFeed(store);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].type, "removed");
  assert.equal(feed[0].personId, 2);
  assert.equal(feed[0].person.designation, "Designer");
});

test("buildChangeGroups: one group PER snap, newest-first, INCLUDING the baseline with an empty events array", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  const groups = buildChangeGroups(store);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((g) => g.at),
    [T1, T0] // newest first
  );
  assert.equal(groups[1].kind, "baseline");
  assert.deepEqual(groups[1].events, []); // the "beginning" marker, not an event
  assert.equal(groups[1].total, 2);
  assert.equal(groups[0].events.length, 1);
  assert.equal(groups[0].events[0].type, "removed");
});

test("buildChangeGroups keeps a no-change snap as a header-only group (empty events), not dropped", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // no-op snap
  const groups = buildChangeGroups(store);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].events, []);
});

test("buildChangeGroups' events are scoped to that snap only — an earlier snap's changes don't leak into a later group", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1), person(2)], T1, "snap"); // 2 joins
  store = applySnap(store, [person(1), person(2)], T2, "snap"); // no further change
  const groups = buildChangeGroups(store);
  assert.equal(groups[0].at, T2);
  assert.deepEqual(groups[0].events, []); // NOT still reporting 2's join
  assert.equal(groups[1].at, T1);
  assert.equal(groups[1].events.length, 1);
  assert.equal(groups[1].events[0].type, "added");
});

test("buildChangeGroups' index matches the snap's own position in store.snaps, not the reversed display position", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1), person(2)], T1, "snap");
  store = applySnap(store, [person(1), person(2), person(3)], T2, "snap");
  const groups = buildChangeGroups(store);
  assert.deepEqual(
    groups.map((g) => g.index),
    [2, 1, 0] // reversed for display, but each keeps its ORIGINAL snaps[] index
  );
});

test("buildChangeGroups includes a designation-changed event, with from/to frozen against later overwrites", () => {
  let store = applySnap(emptyStore(), [person(1, { designation: "Engineer" })], T0, "baseline");
  store = applySnap(store, [person(1, { designation: "Senior Engineer" })], T1, "snap");
  store = applySnap(store, [person(1, { designation: "Staff Engineer" })], T2, "snap");
  const groups = buildChangeGroups(store);
  assert.equal(groups[1].events.length, 1); // the T1 group
  assert.equal(groups[1].events[0].type, "designation-changed");
  assert.equal(groups[1].events[0].from, "Engineer");
  assert.equal(groups[1].events[0].to, "Senior Engineer"); // NOT corrupted by the later Senior->Staff snap
  assert.equal(store.people["1"].designation, "Staff Engineer"); // current profile has moved on
});

test("a no-change snap appends an entry with two empty arrays", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1), person(2)], T1, "snap");
  assert.equal(store.snaps.length, 2);
  assert.deepEqual(store.snaps[1].added, []);
  assert.deepEqual(store.snaps[1].removed, []);
});

test("an updated profile overwrites in place — Object.keys(people).length does not grow", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1, { designation: "Senior Software Engineer" })], T1, "snap");
  assert.equal(Object.keys(store.people).length, 1);
  assert.equal(store.people["1"].designation, "Senior Software Engineer");
});

test("a member with empty teams round-trips (the real 3-<p> card)", () => {
  const store = applySnap(emptyStore(), [person(1, { teams: [] })], T0, "baseline");
  assert.deepEqual(store.people["1"].teams, []);
});

test("personKey coercion: number ids in snaps resolve against string keys in people", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap");
  const removedId = store.snaps[1].removed[0]; // a Number, as stored
  assert.equal(typeof removedId, "number");
  assert.equal(personKey(removedId), "2");
  assert.ok(store.people[personKey(removedId)]);
});

test("formatSnapTime renders a UTC timestamp in the correct LOCAL date and time across a midnight boundary", () => {
  // A fixed offset far enough from UTC that a naive toISOString()-style
  // render would show the wrong date, not just the wrong time. We can't
  // pin the test's own timezone, so assert against what the SAME
  // Intl.DateTimeFormat call (the thing under test) is built on: a
  // Date constructed from the ISO string, formatted with no timeZone
  // override, must NOT equal the raw UTC digits when local != UTC, and
  // must always equal the browser/node's own local rendering.
  const iso = "2026-09-14T18:20:00.000Z";
  const expected = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  assert.equal(formatSnapTime(iso), expected);
});

test("migrate() is identity for v:1 and refuses an unknown version", () => {
  const store = emptyStore();
  assert.deepEqual(migrate(store), store);
  assert.equal(migrate(null).v, 1); // no prior data -> a fresh empty store
  assert.equal(migrate({ v: 2, snaps: [], people: {} }), null);
});

test("migrate() rejects a v:1-tagged object with a malformed/missing shape — the import gate", () => {
  // Storage never wrote these shapes on its own; this is the defense
  // against an arbitrary, possibly hand-edited or truncated, IMPORTED file
  // claiming v:1 while missing what a real store always has.
  assert.equal(migrate({ v: 1 }), null); // no snaps/people at all
  assert.equal(migrate({ v: 1, snaps: [], people: null }), null);
  assert.equal(migrate({ v: 1, snaps: "not an array", people: {} }), null);
  assert.equal(migrate({ v: 1, snaps: [], people: "not an object" }), null);
  // a genuinely well-formed v:1 store still round-trips
  const store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  assert.deepEqual(migrate(store), store);
});

test("snap ordering: appended oldest-first", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap");
  store = applySnap(store, [person(1)], T2, "snap");
  assert.deepEqual(
    store.snaps.map((s) => s.at),
    [T0, T1, T2]
  );
});

test("'when did X leave' derives from snaps[].removed, not from a field on the person", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves at T1
  const snap = lastDepartureSnap(store, 2);
  assert.equal(snap.at, T1);
  // no goneAt-style field anywhere on the stored person
  assert.equal("goneAt" in store.people["2"], false);
});

test("lastDepartureSnap reports the MOST RECENT departure after a leave-rejoin-leave cycle", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  store = applySnap(store, [person(1), person(2)], T2, "snap"); // 2 rejoins
  store = applySnap(store, [person(1)], "2026-11-01T00:00:00.000Z", "snap"); // 2 leaves again
  const snap = lastDepartureSnap(store, 2);
  assert.equal(snap.at, "2026-11-01T00:00:00.000Z"); // not T1
});

test("a stored person carries no email, phone or joinedAt key — regression guard for the rejected fiber path", () => {
  const store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  const stored = store.people["1"];
  assert.equal("email" in stored, false);
  assert.equal("phone" in stored, false);
  assert.equal("joinedAt" in stored, false);
});

test("peopleFor skips ids the store has no record for, rather than throwing", () => {
  const store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  const found = peopleFor(store, [1, 999]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Person 1");
});

test("formerMembers returns only present:false people", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap");
  const former = formerMembers(store);
  assert.equal(former.length, 1);
  assert.equal(former[0].name, "Person 2");
});

test("diffRoster does not mutate the input store", () => {
  const store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  const before = JSON.stringify(store);
  diffRoster(store, [person(1), person(2)]);
  assert.equal(JSON.stringify(store), before);
});

test("deleteSnap is a no-op on the baseline (index 0) or an out-of-range index", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap");
  assert.deepEqual(deleteSnap(store, 0), store);
  assert.deepEqual(deleteSnap(store, 5), store);
  assert.deepEqual(deleteSnap(store, -1), store);
});

test("deleteSnap drops the last snap outright, restoring the prior present state", () => {
  let store = applySnap(emptyStore(), [person(1), person(2)], T0, "baseline");
  store = applySnap(store, [person(1)], T1, "snap"); // 2 leaves
  const after = deleteSnap(store, 1);
  assert.equal(after.snaps.length, 1);
  assert.equal(after.people["2"].present, true); // the removal never happened
});

test("deleteSnap on a middle snap merges its effect forward — a mid-history joiner's firstSeen shifts to the surviving snap", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1), person(2)], T1, "snap"); // 2 joins at T1 (to be deleted)
  store = applySnap(store, [person(1), person(2), person(3)], T2, "snap"); // 3 joins at T2
  const after = deleteSnap(store, 1); // delete T1
  assert.equal(after.snaps.length, 2);
  assert.equal(after.snaps[0].at, T0);
  assert.equal(after.snaps[1].at, T2);
  // 2's join is now attributed to the surviving T2 snap, alongside 3's
  assert.deepEqual(after.snaps[1].added.sort(), [2, 3]);
  assert.equal(after.people["2"].firstSeen, T2);
  // final present state is unaffected by which snap recorded the join
  assert.equal(after.people["1"].present, true);
  assert.equal(after.people["2"].present, true);
  assert.equal(after.people["3"].present, true);
});

test("deleteSnap on a join-then-leave pair (deleting the join) drops both from the surviving snap's diff — never present, never recorded as removed", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1), person(2)], T1, "snap"); // 2 joins (to be deleted)
  store = applySnap(store, [person(1)], T2, "snap"); // 2 leaves again
  const after = deleteSnap(store, 1); // delete the join
  assert.equal(after.snaps.length, 2);
  // 2 was never present between T0 and T2 in the reconstructed history, so
  // the surviving snap has nothing to say about them either way
  assert.equal(after.snaps[1].added.includes(2), false);
  assert.equal(after.snaps[1].removed.includes(2), false);
  assert.equal(after.people["2"].present, false);
});

test("deleteSnap preserves profile fields (name/designation/etc.) untouched", () => {
  let store = applySnap(emptyStore(), [person(1)], T0, "baseline");
  store = applySnap(store, [person(1), person(2, { designation: "Designer" })], T1, "snap");
  store = applySnap(store, [person(1), person(2, { designation: "Designer" })], T2, "snap"); // no-op snap, to delete
  const after = deleteSnap(store, 2);
  assert.equal(after.people["2"].designation, "Designer");
  assert.equal(after.people["2"].name, "Person 2");
});
