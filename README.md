# Cefalo Timeout Extension

The Cefalo Timeout Extension enhances the Cefalo HR Portal: a "Secure End Time" column and a
"Today" countdown panel on the attendance report, and an opt-in join/leave tracker on the member
directory.

Available for **Chrome and Firefox**, built from one source tree.

## Features

- **Secure End Time column**: automatically calculates and displays the recommended leave time
  based on the minimum required hours, shown in 24-hour time with a `(+1d)` marker if it crosses
  midnight.

- **Elapsed time, for today only**: while you're still clocked in today, the column also shows how
  long you've been in. Once you check out, the portal's own Total Work Hour is authoritative and
  the extension gets out of the way.

- **Today panel**: a live countdown card above the portal's own "Attendance Status" summary (and
  inside its narrow-window modal, for smaller screens), showing today's start time, secure end
  time, and time remaining. If you haven't clocked in yet, it shows a calm explanatory message
  instead of a clock counting down from nothing. When the end time is reached, the browser tab
  title gets a `⏰` prefix so a backgrounded tab still flags it — no notification permission is
  requested or required.

- **Local processing only**: all data processing happens locally in your browser, by reading the
  attendance table already on the page. Nothing is transmitted anywhere, and the extension makes
  no network requests of its own.

- **Member directory tracker** *(opt-in)*: on the Team Members page, click **Track** to record the
  current roster, then **Snap** any time after to see what's changed since the last time you
  checked. The "Member changes" list groups every snapshot ever taken — oldest at the bottom,
  marking where tracking began — and shows, per snapshot, exactly who joined, who left, whose team
  changed, and whose position/title changed (Added in green, Removed in red, Team/Position changed
  as "Old → New", right next to each name so it's easy to scan). Snap only ever reads the page and
  asks you to confirm before recording anything — it never modifies the member directory itself (no
  badges, no tags on any card). Nothing is recorded until you click Track, and **Untrack** deletes
  the history permanently (with a confirmation). **Export** saves the whole history to a file;
  **Import** (offered before you Track, and refused if a history already exists) restores it —
  useful when you switch browsers or computers. Only what the page itself displays is stored —
  name, username, designation, team and photo — never email, phone, or anything read from the
  portal's private API.

## Installation

- **Chrome**: install from the Chrome Web Store once published, or load `dist/chrome` unpacked
  via `chrome://extensions` → Developer mode → Load unpacked (see Development below to build it).
- **Firefox**: install the signed add-on from addons.mozilla.org once published, or load
  `dist/firefox/manifest.json` as a temporary add-on via
  `about:debugging#/runtime/this-firefox` for development (temporary add-ons don't survive a
  Firefox restart).

## Development

```bash
npm install
npm run build          # builds both dist/chrome and dist/firefox
npm run build:chrome    # Chrome only
npm run build:firefox   # Firefox only
npm run dev             # Chrome, watch mode
npm test                # runs the unit tests (pure time-math logic only)
npm run zip              # builds, then produces release/*.zip for store upload
```

There is one devDependency (`esbuild`). See `CLAUDE.md` for the full architecture writeup.

## Contributing

1. Fork the repository and clone it locally:

    ```bash
    git clone https://github.com/your-username/your-repo-name.git
    cd your-repo-name
    ```

2. Create a new branch for your feature or bug fix:

    ```bash
    git checkout -b feature/new-feature
    ```

3. Make your changes, run `npm test` and `npm run build`, and verify in a real browser (load the
   relevant `dist/<target>` unpacked) before committing.

4. Commit and push:

    ```bash
    git add .
    git commit -m "Add new feature: describe your changes"
    git push origin feature/new-feature
    ```

## Permissions Justification

This extension declares exactly **one permission, `storage`**, and no `host_permissions`. Its only
other manifest entry relevant to access is a `content_scripts.matches` pattern scoped to
`https://hrportal.cefalolab.com/*` — a statically declared content script derives its host access
from that match pattern alone, and nothing broader is requested. The extension:

- never makes a network request of its own (no `fetch`, no `XMLHttpRequest`) — the one exception is
  the member tracker's "Member changes" thumbnails, which are ordinary `<img>` tags pointing at an
  avatar URL the portal itself already rendered on the page, not a request the extension
  originates;
- never reads `localStorage`, cookies, or any authentication token — `storage` is Chrome's/
  Firefox's own extension storage API (`chrome.storage.local`), never the portal's `localStorage`;
- only reads and modifies the DOM of the attendance table and the "Attendance Status" summary area;
  the member directory grid is only ever **read** (to scrape the visible roster) — the member
  tracker's own UI lives entirely in a separate box next to the grid, and the extension never
  injects anything into a member's own card;
- the member tracker only stores what the directory page visibly displays — name, username,
  designation, team, and an avatar URL — never email, phone, or any field read from the portal's
  authenticated JSON API; nothing is recorded until the user clicks **Track**, and **Untrack**
  deletes it permanently;
- never requests the `Notification` permission — the "time's up" alert is a plain change to the
  browser tab's title, which needs no permission at all.

The content script is loaded on the whole portal host, not only the `/attendance/` path, because
the portal is a single-page app: navigating between its tabs never triggers a full page load, so
a path-restricted match pattern would miss users who land on (say) the login page and click
through to Attendance without a hard reload. The extension only takes any visible action on the
Attendance page itself — this is enforced in code, not by the manifest.

## Privacy Policy

For information about how we handle your data, please refer to our [Privacy Policy](https://jeebon.github.io/cefalo-timeout-chrome-extension/privacy.html).

## Packaging for store upload

```bash
npm run zip
```

This builds both targets and produces `release/cefalo-timeout-chrome-<version>.zip` and
`release/cefalo-timeout-firefox-<version>.zip`, each zipped from inside its `dist/<target>`
directory so `manifest.json` sits at the archive root — the layout both the Chrome Web Store and
AMO expect. Do **not** use Finder's "Compress" (it wraps the selection in a folder and will be
rejected).

Neither build is minified: the code stays human-readable in the browser and on store review.

## License

This project is licensed under the MIT License.
