export function blockKey(element) {
  const startpos = element.getAttribute("data-startpos") || "";
  return `${element.tagName}:${startpos}`;
}

export function sourceOffset(element) {
  const parts = (element.getAttribute("data-startpos") || "").split(":");
  const offset = Number(parts[2]);
  return Number.isFinite(offset) ? offset : null;
}

export function clampedScrollTop(elementTop, targetTop, maxScrollTop) {
  const desired = elementTop - targetTop;
  return Math.max(0, Math.min(maxScrollTop, desired));
}
