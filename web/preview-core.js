export function blockKey(element) {
  const startpos = element.getAttribute("data-startpos") || "";
  return `${element.tagName}:${startpos}`;
}

export function sourceOffset(element) {
  const parts = (element.getAttribute("data-startpos") || "").split(":");
  const offset = Number(parts[2]);
  return Number.isFinite(offset) ? offset : null;
}
