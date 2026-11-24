import { element } from "./dom.js";

export function loadStylesheet(doc, href, name) {
  const link = element("link", null, undefined, { rel: "stylesheet", href }, doc);
  const ready = new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Could not load ${name} stylesheet`));
  });
  doc.head.append(link);
  return { link, ready };
}
