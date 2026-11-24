export function loadStylesheet(doc, href, name) {
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  const ready = new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Could not load ${name} stylesheet`));
  });
  doc.head.append(link);
  return { link, ready };
}
