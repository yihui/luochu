# AGENTS.md

## Mission

Luochu is a lightweight, browser-first code and Djot editor with a local Go
server. Use the linked issues as the backlog; read an issue before working on
it and respect its dependencies. Do not start over without reading the prior
art and current implementation.

## Active work

- Prioritize [#6](https://github.com/yihui/luochu/issues/6) (terminal and
  agent CLIs), [#7](https://github.com/yihui/luochu/issues/7) (git and diff
  review), then [#9](https://github.com/yihui/luochu/issues/9) (browser Wasm).
  Issue #9 currently depends on #8's execution protocol and cache; reconcile
  that dependency when starting #9 rather than claiming native-first and
  shared-protocol support before it exists.
- #6 is in progress on `feature/issue-6-terminal`
  ([draft PR #24](https://github.com/yihui/luochu/pull/24)). Chromium and Go
  tests cover shell I/O, reconnect, resize, authorization, and guarded paste.
  The error helper remains to implement. Real interactive Claude/Copilot and
  RStudio proxy tests remain outstanding; Claude was not installed here.
- [#5](https://github.com/yihui/luochu/issues/5): Djot document experience;
  keep it open until its acceptance criteria are met.
  - [#20](https://github.com/yihui/luochu/issues/20): bidirectional scroll sync.
  - [#21](https://github.com/yihui/luochu/issues/21): visual widget interactions.
  - [#22](https://github.com/yihui/luochu/issues/22): large-document performance.
  - [#23](https://github.com/yihui/luochu/issues/23): numbering and references.
- [#8](https://github.com/yihui/luochu/issues/8): native Djot execution.
- [#10](https://github.com/yihui/luochu/issues/10): export and migration.
- [#11](https://github.com/yihui/luochu/issues/11): proxy and desktop validation.
- [#12](https://github.com/yihui/luochu/issues/12): optional collaboration.

## Working agreements

- Keep changes small, work one issue at a time, and run the narrowest relevant
  tests. Record decisions and remaining work here and in the PR, not as
  progress comments on issues. Remove completed handoffs from this file.
- Keep the implementation simple. Earlier custom iframe messaging, incremental
  patching, and scroll feedback logic made the editor harder to debug. Do not
  reintroduce them without a measured need. Share document CSS rather than
  duplicating it between the editor and preview.
- The preview is sanitized and lives in a script-disabled sandboxed iframe with
  `allow-same-origin`; the parent updates and handles it directly. Never add
  `allow-scripts` to that sandbox or insert unsanitized document HTML. The
  editor's raw HTML widgets also require DOMPurify. Links in the preview must
  not navigate away from the frame.
- Visual mode decorates CodeMirror source, not a separate editable document.
  Preserve source offsets, accurate click placement, and source access to
  widgets. Hidden block-attribute and fence lines must not remove authored
  blank lines; empty blocks need a clickable source affordance.
- Never apply vertical margins to `.cm-line`: they break CodeMirror geometry.
  Keep the visual font on the editor; only revealed source uses monospace.
  Widgets must be measured by CodeMirror. Test real clicks around widgets,
  wrapped lines, and scrolling with Chromium.
- JavaScript uses semicolons and compact declarations; use native CSS nesting
  where appropriate, em-based spacing, and avoid unnecessary dependencies.
- Browser behavior is accepted only after `npm run test:browser` passes.
  Record bundle size and flag regressions when changing frontend code.

## Prior art

- `../lite-edit/README.md` and branch `origin/prototype/visual-editor`,
  commit `cabc797`: `src/tokens.js`, `src/main.js`, `src/app.css`,
  `src/demo.dj`, `test-tokens.mjs`, and `PROTOTYPE.md`.
- `../lite.js/js/render-katex.js` for equation labels and references.
- Djot is core functionality, not a separate lite-edit product. Prefer the
  prototype's simple CodeMirror decoration model.

## Constraints

- The Go server binds to `127.0.0.1`; token authentication, Host and Origin
  validation, and proxy-prefix-safe relative URLs are mandatory.
- External HTTP(S) images are permitted and may reveal the reader's IP to the
  image host; the server uses `Referrer-Policy: no-referrer`. The existing CSP
  permits inline styles for KaTeX; do not weaken it further without review.
  COEP is not currently set; account for this when implementing Wasm features.
- The UI uses a backend-agnostic filesystem and capability flags. Do not add
  remote storage or terminals, LSP, a debugger, refactoring, or a full WYSIWYG
  migration. Dirty buffers and disk conflicts must not be overwritten silently.
- Ship one Go server binary with embedded UI. Generated assets, source maps,
  caches, and release archives are not committed. Keep the initial JS under
  roughly 200 KB compressed and lazy-load expensive functionality.
- Current initial app JS: 132,921 bytes gzip; lazy terminal: 72,549 bytes JS
  and 1,733 bytes CSS gzip. Lazy KaTeX: 77,403 bytes JS and 4,168 bytes CSS
  gzip, plus fonts; the demo loads math at startup. Cold/warm timings remain
  unmeasured; see #22.
- Terminal commands run with user rights. Use Claude and Copilot's normal
  permission prompts; an unrestricted shell cannot enforce per-action approval.
  Never enable agent permission-bypass flags. Keep API keys out of browser
  storage and source control.

## Commands

```bash
npm run dev           # rebuild, start server, and open the app
npm test              # frontend unit tests
npm run test:browser  # real server and Chromium smoke tests
go test ./...         # server tests
```
