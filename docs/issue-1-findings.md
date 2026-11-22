# Issue 1 feasibility findings

## Measured Djot spike

Prototype source: lite-edit commit `cabc7971ed4f496a146a764bf694e9b8f5c80fa4`.
Prototype package versions:

- Node `v26.13.1`
- `@djot/djot` `0.3.2`
- `@codemirror/view` `6.43.15`

The reproducible 5,000-line spike is in `tools/djot-spike/spike.mjs`.
Run `npm ci` and `npm run spike` from that directory.

The exact 5,000-line spike measured:

| Operation | Median |
|---|---:|
| Parse 5000 lines, 179738 bytes | 20.586 ms |
| Parser events | 10.044 ms |
| HTML render | 2.604 ms |
| Prototype tokenization, 14533 spans | 11.564 ms |

The prototype parser did not throw for a deliberately malformed/nested sample.
Editors must therefore treat parser output conservatively and retain source text
rather than assuming malformed input produces an error.

## Resolved implementation defaults

- Inline chunk syntax is `` `code`{.r} ``.
- Cache directory is `.luochu-cache/`.
- Cache and derived artifacts are gitignored by default.
- Execution protocol is a small Luochu JSON/binary protocol using familiar
  Jupyter message names, not Jupyter ZeroMQ or notebook JSON.
- Djot visual mode is hybrid; no full WYSIWYG commitment is made.
- Browser support starts with Chromium FSA, while OPFS/import-export is the
  cross-browser fallback.
- Tauri 2 is the preferred optional desktop shell; Electron is fallback.
- The R runtime remains the primary native path and reuses litedown/fuse.
- A 20 ms parse median is acceptable for an initial implementation. Visual
  decoration and preview patching still require viewport/incremental work
  rather than a full editor hot-path reparse.

## Follow-up spikes

These remain implementation risks rather than unresolved product choices:

- Keyed preview patching and source offsets.
- HTTPS browser to loopback kernel transport.
- Tauri webview behavior and cross-origin isolation.
- webR/Pyodide startup, size, and cancellation behavior.
- Browser git feasibility and remote operations.

These are explicitly assigned to Steps 5, 8, 9, 11, and follow-up issue work.
