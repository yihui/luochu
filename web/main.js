import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import demo from "./demo.dj";
import { tokenize } from "./tokens.js";
import { parse, renderHTML } from "@djot/djot";

function safeTableAlignmentHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const cell of template.content.querySelectorAll("th, td")) {
    const style = cell.getAttribute("style");
    if (!style) continue;
    const match = /^text-align:\s*(left|center|right);?$/.exec(style.trim());
    if (match) {
      cell.classList.add(`dj-al-${match[1]}`);
      cell.removeAttribute("style");
    }
  }
  return template.innerHTML;
}

const setMode = StateEffect.define(), modeField = StateField.define({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMode)) value = effect.value;
    return value;
  },
});

class Widget extends WidgetType {
  constructor(key, make) { super(); this.key = key; this.make = make; }
  eq(other) { return this.key === other.key; }
  toDOM(view) { return this.make(view); }
  ignoreEvent() { return false; }
}

const el = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

const bullet = new Widget("bullet", () => el("span", "dj-bullet", "•")),
  hr = new Widget("hr", () => el("span", "dj-hr-widget"));

function checkbox(token) {
  return new Widget(`check:${token.from}:${token.checked}`, (view) => {
    const input = el("input", "dj-check");
    input.type = "checkbox";
    input.checked = token.checked;
    input.onmousedown = (event) => {
      event.preventDefault();
      view.dispatch({ changes: {
        from: token.from + 1, to: token.from + 2, insert: token.checked ? " " : "x",
      } });
    };
    return input;
  });
}

function buildDecorations(state) {
  const visual = state.field(modeField), doc = state.doc, text = doc.toString();
  const selection = state.selection.main, cursorLine = doc.lineAt(selection.head).number;
  const items = [], lineSeen = new Set();

  for (const token of tokenize(text)) {
    const from = token.from, to = Math.min(token.to, text.length);
    if (to < from) continue;
    const sameLine = doc.lineAt(from).number === doc.lineAt(Math.max(from, to - 1)).number;
    const touches = selection.from <= to && selection.to >= from;

    if (token.kind === "line") {
      const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to - 1)).number;
      for (let line = first; line <= last; line++) {
        const key = `${token.cls}:${line}`;
        if (lineSeen.has(key)) continue;
        lineSeen.add(key);
        items.push({ from: doc.line(line).from, to: doc.line(line).from,
          decoration: Decoration.line({ class: token.cls }) });
      }
    } else if (token.kind === "delim") {
      if (visual && sameLine && doc.lineAt(from).number !== cursorLine && to > from)
        items.push({ from, to, decoration: Decoration.replace({}) });
      else if (to > from)
        items.push({ from, to, decoration: Decoration.mark({ class: "dj-delim dj-source" }) });
    } else if (token.kind === "bullet") {
      if (visual && doc.lineAt(from).number !== cursorLine)
        items.push({ from, to, decoration: Decoration.replace({ widget: bullet }) });
      else items.push({ from, to, decoration: Decoration.mark({ class: "dj-delim" }) });
    } else if (token.kind === "check") {
      if (visual)
        items.push({ from, to, decoration: Decoration.replace({ widget: checkbox(token) }) });
      else items.push({ from, to, decoration: Decoration.mark({ class: "dj-checkbox" }) });
    } else if (token.kind === "hr") {
      if (!touches) items.push({ from, to, decoration: Decoration.replace({ widget: hr }) });
      else items.push({ from, to, decoration: Decoration.mark({ class: "dj-delim" }) });
    } else if (token.kind === "table") {
      if (visual && !touches) {
        const source = text.slice(from, to);
        const tableWidget = new Widget(`table:${source}`, () => {
          const wrapper = el("div", "dj-table-widget");
          wrapper.innerHTML = safeTableAlignmentHTML(renderHTML(parse(source)));
          return wrapper;
        });
        const start = doc.lineAt(from).from, end = doc.lineAt(to - 1).to;
        items.push({ from: start, to: end,
          decoration: Decoration.replace({ widget: tableWidget, block: true }) });
      }
    } else if (token.kind === "image") {
      if (visual && !touches) {
        const imageWidget = new Widget(`image:${token.src}:${token.alt}`, () => {
          const wrapper = el("span", "dj-image"), image = el("img");
          image.src = token.src; image.alt = token.alt; wrapper.append(image);
          return wrapper;
        });
        items.push({ from, to, decoration: Decoration.replace({ widget: imageWidget }) });
      }
    } else if (to > from)
      items.push({ from, to, decoration: Decoration.mark({ class: token.cls }) });
  }
  return Decoration.set(items.map((item) => item.decoration.range(item.from, item.to)), true);
}

const decoField = StateField.define({
  create: buildDecorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection || transaction.effects.length
      ? buildDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const previewFrame = document.querySelector("#preview-frame");
let previewReady = false,
  pendingPreviewHTML = "";
let syncingPreviewScroll = false;
let sourceScrollTimer = null;
let sourceScrollLockUntil = 0;
const previewAssetURL = (name) => {
  const url = new URL(`assets/${name}`, document.baseURI);
  url.search = new URL(document.baseURI).search;
  return url.toString();
};
previewFrame.srcdoc = `<!doctype html><html>
<head><meta charset="utf-8"><link rel="stylesheet" href="${previewAssetURL("preview.css")}"></head>
<body><main id="preview"></main><script src="${previewAssetURL("preview.js")}"></script></body>
</html>`;
const fileTree = document.querySelector("#file-tree"),
  saveButton = document.querySelector("#save-file");
let renderPending = false,
  currentPath = null,
  currentHash = null,
  dirty = false,
  diskConflict = false;
function renderPreview(text) {
  pendingPreviewHTML = safeTableAlignmentHTML(renderHTML(parse(text, { sourcePositions: true })));
  if (previewReady) previewFrame.contentWindow.postMessage(
    { channel: "luochu-preview", type: "render", html: pendingPreviewHTML },
    "*",
  );
}
function schedulePreview(text) {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderPreview(text); });
}

const view = new EditorView({
  parent: document.querySelector("#editor"),
  state: EditorState.create({
    doc: demo,
    extensions: [
      history(), keymap.of([...defaultKeymap, ...historyKeymap]), modeField, decoField,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (currentPath && !diskConflict) {
            dirty = true;
            saveButton.textContent = "Save*";
          }
          schedulePreview(update.state.doc.toString());
        }
      }),
    ],
  }),
});
renderPreview(demo);

const toggle = document.querySelector("#mode-toggle");
const applyMode = (visual) => {
  view.dom.classList.toggle("visual", visual);
  toggle.textContent = visual ? "Source" : "Visual";
  view.dispatch({ effects: setMode.of(visual) });
};
toggle.addEventListener("click", () => applyMode(!view.state.field(modeField)));

view.scrollDOM.addEventListener("scroll", () => {
  if (syncingPreviewScroll || performance.now() < sourceScrollLockUntil) return;
  clearTimeout(sourceScrollTimer);
  sourceScrollTimer = setTimeout(() => {
    if (syncingPreviewScroll || performance.now() < sourceScrollLockUntil) return;
    const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
    const line = view.state.doc.lineAt(top).number;
    const offset = view.state.doc.line(line).from;
    const coords = view.coordsAtPos(offset);
    const scrollRect = view.scrollDOM.getBoundingClientRect();
    const viewportY = coords ? coords.top - scrollRect.top : 0;
    if (previewReady) previewFrame.contentWindow.postMessage(
      { channel: "luochu-preview", type: "scroll", offset, viewportY },
      "*",
    );
  }, 120);
});

window.addEventListener("message", (event) => {
  if (event.source !== previewFrame.contentWindow ||
      event.data?.channel !== "luochu-preview") return;
  if (event.data.type === "ready") {
    previewReady = true;
    previewFrame.dataset.ready = "true";
    if (pendingPreviewHTML) previewFrame.contentWindow.postMessage(
      { channel: "luochu-preview", type: "render", html: pendingPreviewHTML },
      "*",
    );
  } else if (event.data.type === "source-scroll" ||
             event.data.type === "source-click") {
    const offset = event.data.offset;
    if (!Number.isFinite(offset)) return;
    syncingPreviewScroll = true;
    sourceScrollLockUntil = performance.now() + 300;
    view.dispatch({ selection: { anchor: offset } });
    requestAnimationFrame(() => {
      const coords = view.coordsAtPos(offset);
      if (!coords) return;
      const scrollRect = view.scrollDOM.getBoundingClientRect();
      const desiredTop = scrollRect.top + (event.data.viewportY || 0);
      const delta = coords.top - desiredTop;
      view.scrollDOM.scrollTop += delta;
      if (event.data.type === "source-click") view.focus();
      setTimeout(() => { syncingPreviewScroll = false; }, 180);
    });
  }
});

const apiUrl = (path) => new URL(path, document.baseURI).toString();

async function loadTree(directory = "") {
  const response = await fetch(
    apiUrl(`api/files?path=${encodeURIComponent(directory)}`),
    { credentials: "same-origin" },
  );
  if (!response.ok) {
    fileTree.textContent = "Project unavailable";
    return;
  }
  const entries = await response.json();
  fileTree.replaceChildren();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent =
      entry.type === "directory" ? `${entry.name}/` : entry.name;
    button.addEventListener("click", async () => {
      if (entry.type === "directory") {
        await loadTree(entry.path);
      } else {
        await openFile(entry.path);
      }
    });
    fileTree.append(button);
  }
}

async function openFile(path) {
  if (dirty) {
    const discard = window.confirm(
      "Discard unsaved changes and open another file?",
    );
    if (!discard) return;
  }
  const response = await fetch(
    apiUrl(`api/file?path=${encodeURIComponent(path)}`),
    { credentials: "same-origin" },
  );
  if (!response.ok) return;
  const text = await response.text();
  currentPath = path;
  currentHash = response.headers.get("X-Luochu-Hash");
  dirty = false;
  diskConflict = false;
  saveButton.disabled = false;
  saveButton.textContent = "Save";
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  document.title = `Luochu - ${path}`;
}

saveButton.addEventListener("click", async () => {
  if (!currentPath) return;
  const response = await fetch(
    apiUrl(`api/file?path=${encodeURIComponent(currentPath)}`),
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "text/plain",
        "If-Match": currentHash,
      },
      body: view.state.doc.toString(),
    },
  );
  if (response.status === 409) {
    diskConflict = true;
    saveButton.textContent = "Conflict";
    saveButton.title =
      "The file changed on disk; reload or resolve it explicitly";
    return;
  }
  if (!response.ok) return;
  currentHash = response.headers.get("X-Luochu-Hash");
  dirty = false;
  diskConflict = false;
  saveButton.textContent = "Save";
  saveButton.title = "";
});

loadTree();
if (typeof EventSource !== "undefined") {
  const watch = new EventSource(apiUrl("api/watch"));
  watch.addEventListener("change", async (event) => {
    if (!currentPath || event.data !== currentPath) return;
    if (!dirty) await openFile(currentPath);
  });
}
