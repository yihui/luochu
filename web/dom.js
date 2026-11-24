export function element(tag, cls, text, options = {}, doc = document) {
  if (cls && typeof cls === 'object') { options = cls; cls = undefined; }
  else if (text && typeof text === 'object') { options = text; text = undefined; }
  const {attrs = {}, ...properties} = options;
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  Object.assign(node, properties);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

export function button(text, cls, properties = {}) {
  return element('button', cls, text, {type: 'button', ...properties});
}
