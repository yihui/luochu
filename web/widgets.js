import { WidgetType } from "@codemirror/view";
import { imageURL } from "./urls.js";
import { sanitizeHTML } from "./safe-html.js";

class Widget extends WidgetType {
  constructor(key, make) { super(); this.key = key; this.make = make; }
  eq(other) { return this.key === other.key; }
  toDOM(view) { return this.make(view); }
}

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const bullet = new Widget("bullet", () => element("span", "dj-bullet", "•"));

export function checkbox(token) {
  return new Widget(`check:${token.from}:${token.checked}`, (view) => {
    const node = element("input", "dj-check");
    node.type = "checkbox";
    node.checked = token.checked;
    node.setAttribute("aria-label", "Toggle task");
    node.addEventListener("change", () => {
      view.dispatch({ changes: { from: token.from + 1, to: token.from + 2,
        insert: node.checked ? "x" : " " } });
    });
    return node;
  });
}

export function image(token, path) {
  const src = imageURL(token.src, path);
  return new Widget(`image:${src}:${token.alt}`, (view) => {
    const wrapper = element("span", "dj-image"), img = element("img");
    img.alt = token.alt;
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", () => view.requestMeasure());
    img.src = src;
    wrapper.append(img);
    return wrapper;
  });
}

export function rawHTML(token, path) {
  return new Widget(`raw:${token.from}:${token.block}:${token.html}:${path}`, (view) => {
    const wrapper = element(token.block ? "div" : "span", "dj-raw-html");
    wrapper.append(sanitizeHTML(token.html, path));
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: token.from } });
      view.focus();
    });
    for (const img of wrapper.querySelectorAll("img"))
      img.addEventListener("load", () => view.requestMeasure());
    return wrapper;
  });
}

export function footnote(token) {
  return new Widget(`footnote:${token.number}:${token.target}`, (view) => {
    const button = element("button", "dj-footnote-ref", String(token.number));
    button.type = "button";
    button.title = "Go to footnote";
    button.addEventListener("click", () => {
      view.dispatch({ selection: { anchor: token.target }, scrollIntoView: true });
      view.focus();
    });
    return button;
  });
}

export function footnoteLabel(token) {
  return new Widget(`footnote-label:${token.number}`, () =>
    element("span", "dj-footnote-label", `${token.number}.`));
}

let mathModule;
function loadMath() {
  if (!mathModule) {
    const link = element("link");
    link.rel = "stylesheet";
    link.href = new URL("assets/math.css", document.baseURI).href;
    const stylesheet = new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = () => reject(new Error("Could not load math stylesheet"));
    });
    document.head.append(link);
    mathModule = Promise.all([import("./math.js"), stylesheet]).then(([module]) => module);
  }
  return mathModule;
}

export function renderPreviewMath(root) {
  const nodes = root.querySelectorAll(".math.inline, .math.display");
  if (!nodes.length) return;
  loadMath().then(({ renderMath }) => {
    for (const node of nodes) {
      if (!node.isConnected) continue;
      const expression = node.textContent.slice(2, -2);
      renderMath(node, expression, node.classList.contains("display"));
    }
  }).catch((error) => console.error("Math renderer failed:", error));
}

export function math(token) {
  return new Widget(`math:${token.display}:${token.expression}`, (view) => {
    const node = element("span", "dj-math", token.expression);
    loadMath().then(({ renderMath }) => {
      if (!node.isConnected) return;
      renderMath(node, token.expression, token.display);
      view.requestMeasure();
      document.fonts.ready.then(() => view.requestMeasure());
    }).catch((error) => {
      node.classList.add("dj-math-error");
      node.title = `Math renderer failed: ${error.message}`;
      console.error("Math renderer failed:", error);
    });
    return node;
  });
}

function appendInline(parent, children = [], path) {
  const tags = { emph: "em", strong: "strong", mark: "mark", insert: "ins", delete: "del",
    subscript: "sub", superscript: "sup", verbatim: "code" };
  for (const child of children) {
    if (child.tag === "raw_inline" && child.format === "html")
      parent.append(sanitizeHTML(child.text, path));
    else if (child.text !== undefined) parent.append(document.createTextNode(child.text));
    else if (child.tag === "soft_break" || child.tag === "hard_break") parent.append(" ");
    else {
      const node = element(tags[child.tag] || "span");
      appendInline(node, child.children, path);
      parent.append(node);
    }
  }
}

export function table(token, text, path) {
  return new Widget(`table:${token.from}:${text}:${path}`, (view) => {
    const wrapper = element("div", "dj-table-widget"), tableNode = element("table");
    for (const part of token.node.children) {
      if (part.tag === "caption") {
        const caption = element("caption");
        appendInline(caption, part.children, path);
        tableNode.append(caption);
      } else if (part.tag === "row") {
        const row = element("tr");
        for (const cell of part.children) {
          const node = element(cell.head ? "th" : "td", `dj-al-${cell.align}`);
          node.dataset.source = cell.pos.start.offset;
          appendInline(node, cell.children, path);
          row.append(node);
        }
        tableNode.append(row);
      }
    }
    wrapper.append(tableNode);
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const cell = event.target.closest("[data-source]");
      view.dispatch({ selection: { anchor: cell ? Number(cell.dataset.source) : token.from } });
      view.focus();
    });
    return wrapper;
  });
}
