import { blockKey, clampedScrollTop, sourceOffset } from "./preview-core.js";

window.previewLoaded = true;
const root = document.querySelector("#preview");
let previousScroll = 0, syncingFromSource = false, previewScrollTimer = null;

function sanitizedTemplate(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const blocked of template.content.querySelectorAll(
    "script, iframe, object, embed, link, style, meta, base",
  )) {
    blocked.remove();
  }
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (/^(href|src|action|formaction)$/i.test(attribute.name) &&
          /^\s*(?:javascript|data):/i.test(attribute.value))
        element.removeAttribute(attribute.name);
    }
  }
  return template.content;
}

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== "luochu-preview") return;
  if (event.data.type === "render") {
    const incoming = sanitizedTemplate(event.data.html);
    const incomingBlocks = [...incoming.children];
    const existing = new Map();
    for (const element of [...root.children]) existing.set(blockKey(element), element);

    const keep = new Set();
    for (const [index, element] of incomingBlocks.entries()) {
      const key = blockKey(element);
      keep.add(key);
      const current = existing.get(key);
      if (!current) {
        root.insertBefore(element, root.children[index] || null);
      } else if (current.outerHTML !== element.outerHTML) {
        root.insertBefore(element, root.children[index] || null);
        current.remove();
      } else if (root.children[index] !== current) {
        root.insertBefore(current, root.children[index] || null);
      }
    }
    for (const [key, element] of existing) if (!keep.has(key)) element.remove();
  } else if (event.data.type === "scroll") {
    const offset = event.data.offset;
    if (!Number.isFinite(offset)) return;
    let target = null;
    for (const element of root.querySelectorAll("[data-startpos]")) {
      const start = sourceOffset(element);
      if (start === null) continue;
      if (start <= offset) target = element;
      else break;
    }
    if (target) {
      syncingFromSource = true;
      const elementTop = target.offsetTop;
      const maxScroll = document.scrollingElement.scrollHeight - window.innerHeight;
      document.scrollingElement.scrollTop =
        clampedScrollTop(elementTop, event.data.viewportY, Math.max(0, maxScroll));
      setTimeout(() => { syncingFromSource = false; }, 300);
    }
  }
});

document.addEventListener("scroll", () => {
  if (syncingFromSource) return;
  clearTimeout(previewScrollTimer);
  previewScrollTimer = setTimeout(() => {
    if (syncingFromSource) return;
    if (document.scrollingElement.scrollTop === previousScroll) return;
  previousScroll = document.scrollingElement.scrollTop;
  let target = null;
  let bestDistance = Infinity;
  for (const element of root.querySelectorAll("[data-startpos]")) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= 0) continue;
    const distance = Math.abs(rect.top);
    if (distance < bestDistance) {
      target = element;
      bestDistance = distance;
    }
  }
  const offset = target ? sourceOffset(target) : null;
  if (offset !== null) parent.postMessage(
    { channel: "luochu-preview", type: "source-scroll",
      offset, viewportY: target.getBoundingClientRect().top },
    "*",
  );
  }, 120);
}, true);

root.addEventListener("click", (event) => {
  const element = event.target.closest("[data-startpos]");
  if (!element) return;
  const offset = sourceOffset(element);
  if (offset !== null) parent.postMessage(
    { channel: "luochu-preview", type: "source-click",
      offset, viewportY: element.getBoundingClientRect().top },
    "*",
  );
});

parent.postMessage({ channel: "luochu-preview", type: "ready" }, "*");
