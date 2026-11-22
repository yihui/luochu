import { parse, renderHTML } from "@djot/djot";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import demo from "./demo.dj";
import { tokenize } from "./tokens.js";

const setMode = StateEffect.define(),
  modeField = StateField.define({
    create: () => false,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(setMode)) value = effect.value;
      }
      return value;
    },
  });

class Widget extends WidgetType {
  constructor(key, make) {
    super();
    this.key = key;
    this.make = make;
  }
  eq(other) {
    return this.key === other.key;
  }
  toDOM(view) {
    return this.make(view);
  }
  ignoreEvent() {
    return false;
  }
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
      view.dispatch({
        changes: {
          from: token.from + 1,
          to: token.from + 2,
          insert: token.checked ? " " : "x",
        },
      });
    };
    return input;
  });
}

function buildDecorations(state) {
  const visual = state.field(modeField),
    doc = state.doc,
    text = doc.toString(),
    selection = state.selection.main,
    cursorLine = doc.lineAt(selection.head).number,
    items = [],
    lineSeen = new Set();

  for (const token of tokenize(text)) {
    const from = token.from;
    const to = Math.min(token.to, text.length);
    if (to < from) continue;
    const sameLine =
      doc.lineAt(from).number === doc.lineAt(Math.max(from, to - 1)).number;
    const touches = selection.from <= to && selection.to >= from;

    if (token.kind === "line") {
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(Math.max(from, to - 1)).number;
      for (let line = first; line <= last; line++) {
        const key = `${token.cls}:${line}`;
        if (lineSeen.has(key)) continue;
        lineSeen.add(key);
        items.push({
          from: doc.line(line).from,
          to: doc.line(line).from,
          decoration: Decoration.line({ class: token.cls }),
        });
      }
    } else if (token.kind === "delim") {
      if (
        visual &&
        sameLine &&
        doc.lineAt(from).number !== cursorLine &&
        to > from
      ) {
        items.push({ from, to, decoration: Decoration.replace({}) });
      } else if (to > from) {
        items.push({
          from,
          to,
          decoration: Decoration.mark({ class: "dj-delim" }),
        });
      }
    } else if (token.kind === "bullet") {
      if (visual && doc.lineAt(from).number !== cursorLine) {
        items.push({
          from,
          to,
          decoration: Decoration.replace({ widget: bullet }),
        });
      } else {
        items.push({
          from,
          to,
          decoration: Decoration.mark({ class: "dj-delim" }),
        });
      }
    } else if (token.kind === "check") {
      if (visual) {
        items.push({
          from,
          to,
          decoration: Decoration.replace({ widget: checkbox(token) }),
        });
      } else {
        items.push({
          from,
          to,
          decoration: Decoration.mark({ class: "dj-checkbox" }),
        });
      }
    } else if (token.kind === "hr") {
      if (visual && !touches) {
        items.push({
          from,
          to,
          decoration: Decoration.replace({ widget: hr }),
        });
      } else {
        items.push({
          from,
          to,
          decoration: Decoration.mark({ class: "dj-delim" }),
        });
      }
    } else if (token.kind === "table") {
      if (visual && !touches) {
        const source = text.slice(from, to);
        const tableWidget = new Widget(`table:${source}`, () => {
          const wrapper = el("div", "dj-table-widget");
          wrapper.innerHTML = renderHTML(parse(source));
          return wrapper;
        });
        const start = doc.lineAt(from).from;
        const end = doc.lineAt(to - 1).to;
        items.push({
          from: start,
          to: end,
          decoration: Decoration.replace({ widget: tableWidget, block: true }),
        });
      }
    } else if (token.kind === "image") {
      if (visual && !touches) {
        const imageWidget = new Widget(
          `image:${token.src}:${token.alt}`,
          () => {
            const wrapper = el("span", "dj-image");
            const image = el("img");
            image.src = token.src;
            image.alt = token.alt;
            wrapper.append(image);
            return wrapper;
          },
        );
        items.push({
          from,
          to,
          decoration: Decoration.replace({ widget: imageWidget }),
        });
      }
    } else if (to > from) {
      items.push({
        from,
        to,
        decoration: Decoration.mark({ class: token.cls }),
      });
    }
  }

  return Decoration.set(
    items.map((item) => item.decoration.range(item.from, item.to)),
    true,
  );
}

const decoField = StateField.define({
  create: buildDecorations,
  update(value, transaction) {
    return transaction.docChanged ||
      transaction.selection ||
      transaction.effects.length
      ? buildDecorations(transaction.state)
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const preview = document.querySelector("#preview");
let renderPending = false;
function renderPreview(text) {
  preview.innerHTML = renderHTML(parse(text, { sourcePositions: true }));
}
function schedulePreview(text) {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderPreview(text);
  });
}

const view = new EditorView({
  parent: document.querySelector("#editor"),
  state: EditorState.create({
    doc: demo,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      modeField,
      decoField,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) schedulePreview(update.state.doc.toString());
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

const previewPane = document.querySelector("#preview-pane");
view.scrollDOM.addEventListener("scroll", () => {
  const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
  const line = view.state.doc.lineAt(top).number;
  let target = null;
  for (const element of preview.querySelectorAll("[data-startpos]")) {
    const startLine = Number(element.dataset.startpos.split(":")[0]);
    if (startLine <= line) target = element;
    else break;
  }
  if (target) previewPane.scrollTop = target.offsetTop - previewPane.offsetTop;
});

preview.addEventListener("click", (event) => {
  const element = event.target.closest("[data-startpos]");
  if (!element) return;
  const sourceOffset = Number(element.dataset.startpos.split(":")[2]);
  view.dispatch({ selection: { anchor: sourceOffset }, scrollIntoView: true });
  view.focus();
});
