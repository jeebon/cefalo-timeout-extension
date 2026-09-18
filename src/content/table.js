// Everything in this file is DOM mechanics only — no time math, no "is this
// today" logic. That lives in index.js, which passes in a computeCellText
// callback. Keeping the split means the AntD-specific plumbing here can be
// unit-tested against a fixture DOM later without dragging in date logic,
// and vice versa.

import { HEADER_TEXT, MARKER_ATTR } from "../lib/config.js";

function normText(el) {
  if (!el) return "";
  // The sortable "Date" header wraps its text in a nested
  // span.ant-table-column-title (next to the sort-arrow icons); other
  // headers don't have one, so fall back to the cell itself.
  const titleEl = el.querySelector(".ant-table-column-title");
  const source = titleEl || el;
  return source.textContent.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Find the AntD table wrapper that renders the attendance table, identified
 * by header TEXT rather than a class hash. `css-1m77us0`-style emotion
 * classes change on every AntD/build bump; header text is what a human
 * reading the page relies on, so it's the more durable anchor.
 * @returns {Element|null}
 */
export function findTable() {
  const wrappers = document.querySelectorAll(".ant-table-wrapper");
  for (const wrapper of wrappers) {
    const texts = getHeaderTexts(wrapper);
    if (texts.includes(HEADER_TEXT.startTime) && texts.includes(HEADER_TEXT.date)) {
      return wrapper;
    }
  }
  return null;
}

/** @param {Element} wrapper @returns {string[]} */
export function getHeaderTexts(wrapper) {
  const headerRow = wrapper.querySelector("thead tr:first-child");
  if (!headerRow) return [];
  return [...headerRow.children].map((th) => normText(th));
}

/**
 * `statusIdx` is -1, not a bail, when the portal doesn't have that column —
 * only Start/End Time are load-bearing for the column itself; the Today
 * panel treats status as optional enrichment.
 * @param {string[]} headerTexts
 * @returns {{srcIdx:number, endIdx:number, insertAt:number, statusIdx:number}|null}
 */
export function computeIndices(headerTexts) {
  const srcIdx = headerTexts.indexOf(HEADER_TEXT.startTime);
  const endIdx = headerTexts.indexOf(HEADER_TEXT.endTime);
  if (srcIdx === -1 || endIdx === -1) return null;
  return {
    srcIdx,
    endIdx,
    insertAt: endIdx + 1,
    statusIdx: headerTexts.indexOf(HEADER_TEXT.status),
  };
}

// Shared by index.js for both the column's per-row loop and the panel's
// today-row lookup, so the two never drift on what counts as "a data row".
export const DATA_ROW_SELECTOR = ".ant-table-tbody > tr[data-row-key]:not(.ant-table-measure-row)";

/**
 * Text of one cell, blank for a missing/-1 column index rather than
 * throwing — lets optional columns (Total Work Hour, Status) be absent.
 * @param {Element} row
 * @param {number} idx
 */
export function cellText(row, idx) {
  if (idx == null || idx < 0) return "";
  return row.children[idx]?.textContent.trim() ?? "";
}

/**
 * The single text-only anchor for the right-rail summary card, valid in
 * BOTH its layouts: the sticky rail at >=1024px, and the AntD modal the
 * portal swaps it for below that width (measured live — the rail is not
 * hidden with CSS at that width, it is removed from the DOM entirely).
 * Deliberately never touches the Tailwind utility-class soup wrapping
 * either container — that's rewritten on every layout tweak, and
 * `lg:sticky` would need escaping to even query.
 * @returns {{mode:"rail"|"modal", container:Element, reference:Element}|null}
 */
export function findSummaryMount() {
  const anchor = [...document.querySelectorAll("span, div")].find(
    (el) => el.children.length === 0 && el.textContent.trim() === "Attendance Status"
  );
  if (!anchor) return null;

  const card = anchor.closest(".ant-card");
  if (card && card.parentElement) {
    return { mode: "rail", container: card.parentElement, reference: card };
  }

  const modalBody = anchor.closest(".ant-modal-body");
  if (modalBody) {
    let block = anchor;
    while (block.parentElement && block.parentElement !== modalBody) block = block.parentElement;
    if (block.parentElement === modalBody) {
      return { mode: "modal", container: modalBody, reference: block };
    }
  }

  return null;
}

export function removeInjected() {
  document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((node) => node.remove());
}

/**
 * Insert a "Secure End Time" column. Handles:
 *  - BOTH colgroups (header table + body table — they are NOT symmetric:
 *    the header's carries AntD's resolved pixel widths, the body's carries
 *    the originally declared ones — both need a <col> or the column widths
 *    shear apart under table-layout:fixed).
 *  - the sticky header's single <thead> row.
 *  - the layout-only `tr.ant-table-measure-row` — patching this is what
 *    keeps AntD from discarding our column when it next re-measures.
 *  - every real data row (`tr[data-row-key]`, i.e. not the measure row).
 *
 * @param {Element} wrapper
 * @param {number} insertAt
 * @param {(row: Element) => string} computeCellText
 */
export function injectColumn(wrapper, insertAt, computeCellText) {
  wrapper.querySelectorAll("colgroup").forEach((colgroup) => {
    const col = document.createElement("col");
    col.style.width = "160px";
    col.setAttribute(MARKER_ATTR, "1");
    colgroup.insertBefore(col, colgroup.children[insertAt] || null);
  });

  const headerRow = wrapper.querySelector("thead tr:first-child");
  if (headerRow) {
    const th = document.createElement("th");
    // Inherit AntD's own cell padding/border/font — without this class the
    // injected header looks visibly out of place on first render.
    th.className = "ant-table-cell";
    th.setAttribute(MARKER_ATTR, "1");
    th.textContent = "Secure End Time";
    headerRow.insertBefore(th, headerRow.children[insertAt] || null);
  }

  const measureRow = wrapper.querySelector("tr.ant-table-measure-row");
  if (measureRow) {
    const td = document.createElement("td");
    td.className = "ant-table-measure-cell";
    td.setAttribute(MARKER_ATTR, "1");
    measureRow.insertBefore(td, measureRow.children[insertAt] || null);
  }

  const rows = wrapper.querySelectorAll(DATA_ROW_SELECTOR);
  rows.forEach((row) => {
    const td = document.createElement("td");
    td.className = "ant-table-cell cto-cell";
    td.setAttribute(MARKER_ATTR, "1");
    td.textContent = computeCellText(row);
    row.insertBefore(td, row.children[insertAt] || null);
  });
}
