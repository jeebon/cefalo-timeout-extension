// DOM mechanics only for the "Today" countdown panel — no time math, no
// lifecycle policy. Mirrors table.js's split: index.js decides WHAT to show
// (via lib/time.js's derivePanelState) and WHEN; this file only knows HOW to
// build and paint the card. See CLAUDE.md for the panel's separate lifecycle
// (create-once + update-in-place, unlike the column's remove-then-rebuild).

import { PANEL_ATTR } from "../lib/config.js";

/**
 * Build the panel DOM once, fully detached. The caller inserts it into the
 * page only after this returns — never expose a half-built node, or a throw
 * partway through construction could otherwise leave a headless card behind
 * (see PANEL_READY_ATTR in index.js).
 *
 * @param {"rail"|"modal"} mode
 * @returns {{node: Element, refs: object}}
 */
export function createPanel(mode) {
  const node = document.createElement("div");
  node.setAttribute(PANEL_ATTR, "1");
  node.className = panelChromeClass(mode);

  const head = document.createElement("div");
  head.className = "ant-card-head";
  const headWrapper = document.createElement("div");
  headWrapper.className = "ant-card-head-wrapper";
  const headTitle = document.createElement("div");
  headTitle.className = "ant-card-head-title cto-panel-head";

  const heading = document.createElement("span");
  heading.textContent = "Today";

  const statusChip = document.createElement("span");
  statusChip.className = "cto-panel-status";
  const statusText = document.createTextNode("");
  statusChip.appendChild(statusText);

  headTitle.append(heading, statusChip);
  headWrapper.appendChild(headTitle);
  head.appendChild(headWrapper);

  const body = document.createElement("div");
  body.className = "ant-card-body cto-panel-body";

  const countdown = document.createElement("div");
  countdown.className = "cto-panel-countdown";
  const countdownText = document.createTextNode("");
  countdown.appendChild(countdownText);

  const label = document.createElement("div");
  label.className = "cto-panel-label";
  const labelText = document.createTextNode("");
  label.appendChild(labelText);

  const bar = document.createElement("div");
  bar.className = "cto-panel-bar";
  const barFill = document.createElement("div");
  barFill.className = "cto-panel-bar-fill";
  bar.appendChild(barFill);

  const meta = document.createElement("div");
  meta.className = "cto-panel-meta";
  const startMeta = document.createElement("span");
  const startMetaText = document.createTextNode("");
  startMeta.appendChild(startMetaText);
  const endMeta = document.createElement("span");
  const endMetaText = document.createTextNode("");
  endMeta.appendChild(endMetaText);
  meta.append(startMeta, endMeta);

  body.append(countdown, label, bar, meta);
  node.append(head, body);

  return {
    node,
    refs: {
      root: node,
      statusText,
      countdownText,
      labelText,
      barFill,
      startMetaText,
      endMetaText,
    },
  };
}

/**
 * Rail mode reuses AntD's own `.ant-card` chrome to inherit border/radius/
 * shadow for free. Modal mode drops it — the narrow-window modal the portal
 * swaps the rail for has no card chrome of its own around its content
 * either, so keeping ours would look like a card nested in a dialog.
 * `.ant-card-head`/`.ant-card-body` stay in both modes; they're plain class
 * selectors (not scoped to `.ant-card`), so padding/font still apply.
 * @param {"rail"|"modal"} mode
 */
function panelChromeClass(mode) {
  return mode === "modal"
    ? "cto-panel cto-panel--modal"
    : "ant-card ant-card-bordered cto-panel";
}

/**
 * Paint one derived state (see lib/time.js#derivePanelState) into an
 * existing panel's refs. Every write here is a `Text.data` assignment or a
 * style/dataset write — never `element.textContent` and never a DOM
 * structural change — so a per-second refresh produces zero `childList`
 * mutation records and can't feed the page's own MutationObserver loop.
 * @param {object} refs
 * @param {object} state
 */
export function renderPanel(refs, state) {
  refs.root.dataset.ctoState = state.kind;
  refs.statusText.data = state.statusText || "";

  switch (state.kind) {
    case "loading": {
      refs.countdownText.data = "--:--:--";
      refs.labelText.data = "";
      refs.barFill.style.width = "0%";
      refs.startMetaText.data = "";
      refs.endMetaText.data = "";
      break;
    }
    case "waiting": {
      refs.countdownText.data = "—";
      refs.labelText.data =
        "Not clocked in yet — the countdown starts once a Start Time appears.";
      refs.barFill.style.width = "0%";
      refs.startMetaText.data = "";
      refs.endMetaText.data = "";
      break;
    }
    case "running": {
      refs.countdownText.data = state.remaining;
      refs.labelText.data = `until ${state.end}`;
      refs.barFill.style.width = `${Math.round(state.ratio * 100)}%`;
      refs.startMetaText.data = `In ${state.start}`;
      // "Time Spent", not "In office" — the panel has no signal for whether
      // the person is still physically present (see derivePanelState's
      // docblock), so this reports elapsed-since-clock-in, not a presence
      // claim it can't back.
      refs.endMetaText.data = `Time Spent: ${state.inOffice}`;
      break;
    }
    case "timeup": {
      // Frozen, not a growing overtime counter — the countdown stops the
      // instant Secure End Time is reached and stays on this message,
      // rather than counting how far past it you've gone.
      refs.countdownText.data = "Time's up!";
      refs.labelText.data = `past ${state.end} — you're clear to go`;
      refs.barFill.style.width = "100%";
      refs.startMetaText.data = `In ${state.start}`;
      refs.endMetaText.data = `Time Spent: ${state.inOffice}`;
      break;
    }
  }
}
