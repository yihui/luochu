# AGENTS.md

## Mission

Build Luochu as a small, browser-first code and Djot document editor with a
local Go server. Use the GitHub issues below as the implementation backlog.
Do not restart implementation from this file; the issue bodies contain the
scope and acceptance criteria for the active step.

Repository: https://github.com/yihui/luochu

## Working with implementation steps

JavaScript source style:

- Use semicolons.
- Combine adjacent `const` declarations into comma-separated declarations.
  Do not split them merely for minifier assumptions; generated output may be
  minified separately.
- Use native CSS nesting when a selector is structurally grouped, such as
  layout children, state variants, widget internals, preview elements, and
  responsive overrides.
- Keep source compact. Put simple declarations, selectors, arguments, and
  short objects on one line; break a line only when it exceeds roughly 100
  characters or nesting/semantics require it.
- Prefer em-based CSS lengths for scalable spacing and component dimensions.
  Use px for borders and hairline details.
- Avoid `!important`; use specificity or cascade order unless an override
  is genuinely unavoidable.

1. Work one issue at a time. Read the issue before editing:
   `gh issue view <number> --repo yihui/luochu`
2. Respect dependencies. Do not start a later issue while a prerequisite is
   incomplete unless the issue explicitly says it can proceed in parallel.
3. Keep changes small and landable. Run the narrowest relevant tests.
4. Add a handoff to this file whenever work changes progress, decisions,
   commands, or known blockers.
5. Update the GitHub issue when substantial work is done. Record commits,
   design decisions, tests, remaining work, and verification commands.
6. Close an issue only when its acceptance criteria are demonstrably met.
   Open follow-up issues instead of widening scope.
7. Never silently change a resolved architecture decision. Record a change
   here and explain why in the relevant issue or pull request.

## Progress

| Step                                            | Issue                                            |                                            Status | Outcome / handoff                      |
| ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------: | -------------------------------------- |
| Architecture and feasibility spikes             | [#1](https://github.com/yihui/luochu/issues/1)   | PR [#13](https://github.com/yihui/luochu/pull/13) | Findings and benchmark complete        |
| Go server and Host API                          | [#2](https://github.com/yihui/luochu/issues/2)   | PR [#14](https://github.com/yihui/luochu/pull/14) | Stacked on #13; Go skeleton and tests  |
| CodeMirror and Djot source/visual core | [#3](https://github.com/yihui/luochu/issues/3) | Closed | Merged via PR #15, squash commit 01bae6a |
| File tree, watching, conflicts, and SPA storage | [#4](https://github.com/yihui/luochu/issues/4) | Closed | Merged via PR #18, squash commit 5556387 |
| Djot preview and visual widgets                 | [#5](https://github.com/yihui/luochu/issues/5)   |                                              Open | Blocked by #3-#4                       |
| Terminal and agent CLIs                         | [#6](https://github.com/yihui/luochu/issues/6)   |                                              Open | Blocked by #2-#4                       |
| Git and patch/diff review                       | [#7](https://github.com/yihui/luochu/issues/7)   |                                              Open | Blocked by #2-#4                       |
| Native Djot chunk execution and cache           | [#8](https://github.com/yihui/luochu/issues/8)   |                                              Open | Blocked by #1-#3                       |
| Browser Wasm runtimes                           | [#9](https://github.com/yihui/luochu/issues/9)   |                                              Open | Blocked by #8                          |
| Export, document filters, and migration         | [#10](https://github.com/yihui/luochu/issues/10) |                                              Open | Blocked by #5-#8                       |
| Proxy and desktop validation                    | [#11](https://github.com/yihui/luochu/issues/11) |                                              Open | Blocked by #2-#9                       |
| Optional collaboration                          | [#12](https://github.com/yihui/luochu/issues/12) |                                              Open | Last; blocked by #2-#11                |

**Current state:** No implementation work or repository scaffold is present in
the Luochu checkout yet. Issue #1 is the first step. All prior implementation
plan detail has moved into issue bodies; future sessions should treat GitHub
issues and this section as the source of truth.

**Recent handoff (2026-11-21):**

- Initialized the `yihui/luochu` checkout, pushed baseline commit `cd61d31`.
- Created and verified GitHub issues #1-#12.
- Installed Go `1.27.4` (`/opt/homebrew/bin/go`) with Homebrew for server
  implementation. This is a system tool, not a project dependency.
- Node/npm are already present and were not newly installed.
- Issue #1 is active on branch `spike/issue-1-feasibility`; it records
  reproducible Djot/parser benchmarks from lite-edit prototype commit
  `cabc7971ed4f496a146a764bf694e9b8f5c80fa4`.
- Issue #2 was merged through recovery PR #17 onto `main`.
- PR #13 is the Issue #1 stack; PR #14 is stacked on its branch for Issue #2.
- Issue #3 is in progress on branch `stack/issue-3-djot-editor`.
- Initial Issue #3 build is 834226 bytes uncompressed and 180696 bytes gzipped
  for app.js, plus 2159 bytes of CSS.
- PR #15 was merged into `main` as squash commit `01bae6a` on 2026-11-21.
  The old PR #15 branch was deleted. PR #16 is closed because its old base
  branch disappeared; do not continue or modify it until Issue #4 is rebuilt
  onto current `main`.
- Frontend build correction: generated `server/static/assets/*` files are
  ignored and not committed. Esbuild output is minified without source maps;
  the corrected initial app bundle is 353 KB uncompressed / 112784 bytes gzip,
  plus 1.7 KB CSS. Source maps are development tools, not runtime assets.
- Issue #4 implementation completed a project-root file API and browser tree:
  live list/read/rename/conflict-write checks passed.
- PR stack correction (2026-11-21):
  PR #14 was incorrectly merged onto the Issue #1 branch instead of `main`.
  PR #17 now merges the server work onto `main`. PR #15 is based on `main`,
  and PR #16 is stacked on PR #15's branch. Do not rebuild the stack from the
  old `spike/issue-1-feasibility` or `stack/issue-2-server-skeleton` branches.
- Temporary `/tmp/luochu-file-smoke` and `/tmp/luochu-file-read.out` were removed.
- No major maintainer decision was blocked; remaining browser git, PDF, and
  collaboration choices remain explicitly deferred.
- Temporary lite-edit worktree `/tmp/lite-edit-prototype-spike` will be removed
  after npm dependencies finish and benchmarks are complete.
- Record any further new Homebrew formulae/casks here before relying on them.

## Prior art

Before changing architecture, read these sources:

- Lite-edit README:
  `../lite-edit/README.md`
- Lite-edit prototype branch:
  `origin/prototype/visual-editor`, commit
  `cabc797` ("Add djot visual editor prototype")
- Useful prototype files:
  `src/tokens.js`, `src/main.js`, `src/app.css`, `src/demo.dj`,
  `test-tokens.mjs`, `build.mjs`, and `PROTOTYPE.md`
- The prototype was not a separate product to build. Port its pure tokenizer,
  visual decorations, preview behavior, and build approach into Luochu.
- Djot support is core Luochu behavior, not an optional lite-edit integration.

## Product constraints

- Local server binds to `127.0.0.1` by default.
- Every HTTP request and WebSocket upgrade requires a random per-session token.
- Validate Origin and Host. Keep the origin allowlist configurable.
- Use relative URLs and mounted-prefix-safe WebSocket paths.
- Never render untrusted document or agent output as HTML without sanitization.
- Generated build output, bundles, source maps, cache directories, and
  release archives are not committed to source control. They are produced for
  local builds or packaged only in release/distribution artifacts.
- Preview untrusted documents in a sandboxed iframe.
- Dirty buffers and disk conflicts must never be overwritten silently.
- Agent edits arrive as patches and require hunk-level accept/reject.
- Agent commands run with user rights and require confirmation by default.
- Keep API keys out of browser storage and source control.
- Initial JS is targeted below roughly 200 KB compressed; lazy-load terminal,
  git, Djot runtime features, wasm, grammars, and diff review.
- Virtualize long file/search/git lists and show progress for large loads.
- Do not add remote storage, remote terminals, LSP, debugger, refactoring,
  Monaco, or a full WYSIWYG migration in this plan.

## Resolved defaults

These are implementation defaults, not invitations to reopen discussion:

- Server: Go, `go:embed`, `creack/pty`, `fsnotify`.
- Editor: CodeMirror 6 with a hybrid source/visual Djot mode.
- Parser: pinned `@djot/djot` with source positions.
- Block chunks: fenced code blocks with an engine name and `#|` options.
- Inline chunk syntax: `` `code`{.r} ``.
- Cache: `.luochu-cache/`, gitignored by default.
- Execution protocol: small Luochu JSON/binary protocol using familiar Jupyter
  message names.
- Browser: Chromium for full FSA; all other browsers use OPFS/import-export
  until better support is measured.
- Agent v1: existing CLI in a terminal/PTY plus patch review, no in-app agent
  chat tool loop.
- Collaboration: optional, last, feature-flagged.

## Decision and handoff rules

When a session reaches a material decision or completes a deliverable, update:

1. This progress table: status, issue outcome, and next step.
2. The GitHub issue: decision, files changed, tests, blockers, and follow-ups.
3. A pull request or commit if the repository and task policy call for one.
4. An open-question section below only for decisions that are genuinely unresolved.

Use this handoff structure at the end of a substantial task:

```text
Handoff
- Active issue:
- Completed:
- Changed files:
- Verified:
- Not verified:
- Decisions made:
- Known blockers:
- Next action:
```

Do not use "in progress" without a named issue and next action.

## Open decisions

Still require spikes or maintainer decisions:

- Browser git implementation and remote operation support.
- PDF/print export behavior.
- Desktop shell choice: preferred Tauri 2, Electron fallback.
- Whether published cache artifacts should become committable.
- Collaboration CRDT, execution ownership, and server topology.
- Final license and repository home.

## Commands

Verified server commands:

```bash
go mod download
go test ./...
gofmt -w cmd/luochu/main.go server/*.go
go run ./cmd/luochu
go run ./cmd/luochu -port 48765 -base-path /proxy
```

Verified Djot benchmark commands:

```bash
cd tools/djot-spike
npm ci
npm run spike
```
