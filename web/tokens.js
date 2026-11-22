// Map Djot parser events to editor spans. Pure (no DOM), also runs in Node.
import { isBlock, isInline, parse, parseEvents } from "@djot/djot";

// Explicit editor controls: these annotations need special source behavior.
const SKIP = new Set(["para", "list", "section"]),
  WHOLE = new Set(["attributes", "block_attributes", "destination", "reference"]),
  LEAF_HIDE = new Set([
    "attr_class_marker", "attr_id_marker", "attr_equal_marker", "attr_space",
    "open_marker", "image_marker", "escape",
  ]),
  LEAF_SKIP = new Set(["str", "soft_break", "blankline", "hard_break"]),
  EVENT_TAGS = new Map([["linktext", "link"], ["imagetext", "image"]]),
  nameOf = (annot) => annot.slice(1).split("|")[0],
  subOf = (annot) => annot.split("|")[1];

function collectTagNames(ast, predicate) {
  const names = new Set();
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.tag === "string" && predicate(node)) names.add(node.tag);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast);
  return names;
}

export function tokenize(text) {
  const ast = parse(text, { sourcePositions: true }),
    inlineNames = collectTagNames(ast, isInline),
    blockNames = collectTagNames(ast, isBlock),
    out = [], stack = [], pairs = [], footnoteNumbers = new Map(), tables = new Map();

  function collectNodes(node) {
    if (!node || typeof node !== "object") return;
    if (node.tag === "table") tables.set(node.pos.start.offset, node);
    if ((node.tag === "raw_inline" || node.tag === "raw_block") && node.format === "html") {
      const from = node.pos.start.offset, end = node.pos.end.offset + 1,
        suffix = node.tag === "raw_inline" ? text.slice(end).match(/^\{=html\}/i)?.[0] || "" : "";
      out.push({ kind: "raw", from, to: end + suffix.length, html: node.text,
        block: node.tag === "raw_block" });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collectNodes);
      else if (value && typeof value === "object") collectNodes(value);
    }
  }
  collectNodes(ast);

  for (const event of parseEvents(text)) {
    const annot = event.annot;
    if (annot[0] === "+") stack.push({ name: nameOf(annot), sub: subOf(annot), event });
    else if (annot[0] === "-") {
      const name = nameOf(annot), index = stack.map((item) => item.name).lastIndexOf(name);
      if (index < 0) continue;
      const [open] = stack.splice(index, 1);
      pairs.push({ name, sub: open.sub, open: open.event, close: event });
    } else leaf(event);
  }
  for (const open of stack)
    pairs.push({ name: open.name, sub: open.sub, open: open.event, close: null });
  pairs.sort((a, b) => a.open.startpos - b.open.startpos);
  for (const pair of pairs) pairToken(pair);
  images(pairs);
  for (const [label, number] of footnoteNumbers) {
    const note = ast.footnotes[label], from = note.pos.start.offset,
      marker = text.slice(from).match(/^\[\^[^\]\n]+\]:/);
    if (marker) out.push({ kind: "footnote_label", from, to: from + marker[0].length, number });
  }
  return out;

  function leaf(event) {
    const annot = event.annot, from = event.startpos, to = event.endpos + 1;
    if (LEAF_SKIP.has(annot)) return;
    if (LEAF_HIDE.has(annot)) return out.push({ kind: "delim", from, to });
    if (annot === "thematic_break") {
      const length = text.slice(from).match(/^[*-][*\- \t]*/)[0].trimEnd().length;
      return out.push({ kind: "hr", from, to: from + length });
    }
    if (annot === "checkbox_checked" || annot === "checkbox_unchecked")
      return out.push({ kind: "check", from, to, checked: annot === "checkbox_checked" });
    if (annot === "footnote_reference") {
      const label = text.slice(from + 2, to - 1), note = ast.footnotes[label];
      if (note) {
        if (!footnoteNumbers.has(label)) footnoteNumbers.set(label, footnoteNumbers.size + 1);
        return out.push({
          kind: "footnote", from, to, number: footnoteNumbers.get(label),
          target: note.pos.start.offset,
        });
      }
    }
    out.push({ kind: "mark", from, to, cls: "dj-" + annot });
  }

  function images(items) {
    for (const item of items) {
      if (item.name !== "imagetext" || !item.close) continue;
      const destination = items.find((candidate) =>
        candidate.name === "destination" && candidate.close &&
        candidate.open.startpos === item.close.endpos + 1);
      const reference = items.find((candidate) =>
        candidate.name === "reference" && candidate.close &&
        candidate.open.startpos === item.close.endpos + 1);
      const tail = destination || reference;
      if (!tail || text[item.open.startpos - 1] !== "!") continue;
      const alt = text.slice(item.open.endpos + 1, item.close.startpos);
      const label = reference ? text.slice(reference.open.endpos + 1, reference.close.startpos) || alt : "";
      const src = destination
        ? text.slice(destination.open.endpos + 1, destination.close.startpos).trim().split(/\s+/)[0]
        : ast.references[label]?.destination || "";
      out.push({
        kind: "image", from: item.open.startpos - 1, to: tail.close.endpos + 1, alt, src,
      });
    }
  }

  function pairToken({ name, sub, open, close }) {
    if (SKIP.has(name)) return;
    const end = close ? close.endpos + 1 : text.length;
    if (name === "block_attributes")
      return out.push({
        kind: "delim", from: open.startpos, to: close ? close.startpos : text.length,
      });
    if (WHOLE.has(name)) return out.push({ kind: "delim", from: open.startpos, to: end });

    if (inlineNames.has(name) || inlineNames.has(EVENT_TAGS.get(name) || "")) {
      const newlineClose = !close || text[close.startpos] === "\n";
      const openerEnd = name === "heading"
        ? open.startpos + text.slice(open.startpos).match(/^#+[ \t]*/)[0].length : open.endpos + 1;
      out.push({ kind: "delim", from: open.startpos, to: openerEnd });
      const closerEnd = newlineClose ? (close ? close.startpos : text.length) : close.startpos;
      if (close && (name === "inline_math" || name === "display_math"))
        out.push({ kind: "math", from: open.startpos, to: end,
          expression: text.slice(openerEnd, closerEnd), display: name === "display_math" });
      if (!newlineClose) out.push({ kind: "delim", from: close.startpos, to: close.endpos + 1 });
      if (closerEnd > openerEnd)
        out.push({ kind: "mark", from: openerEnd, to: closerEnd, cls: "dj-" + name });
    }
    if (blockNames.has(name) && (name === "code_block" || name === "div")) {
      out.push({ kind: "delim", from: open.startpos, to: open.endpos + 1 });
      if (close && /^[`:]/.test(text[close.startpos]))
        out.push({ kind: "delim", from: close.startpos, to: close.endpos + 1 });
    }
    if (name === "block_quote") {
      let pos = open.startpos;
      while (pos < end) {
        const newline = text.indexOf("\n", pos);
        const marker = text.slice(pos, newline < 0 ? end : newline).match(/^[ \t]*>[ ]?/);
        if (marker) out.push({
          kind: "delim", from: pos + marker[0].indexOf(">"), to: pos + marker[0].length,
        });
        if (newline < 0) break;
        pos = newline + 1;
      }
    }
    if (name === "table") {
      const node = tables.get(open.startpos);
      let to = Math.max(end, ...(node?.children || []).map((child) => child.pos?.end.offset + 1 || 0));
      while (to > open.startpos && text[to - 1] === "\n") to--;
      out.push({ kind: "table", from: open.startpos, to, node });
    }
    if (name === "list_item") {
      const marker = text[open.startpos];
      if (sub === "X") out.push({ kind: "delim", from: open.startpos, to: open.endpos + 1 });
      else if (
        sub === "-" || sub === "+" || sub === "*" ||
        marker === "-" || marker === "+" || marker === "*"
      )
        out.push({ kind: "bullet", from: open.startpos, to: open.endpos + 1 });
      else if (sub === ":")
        out.push({ kind: "mark", from: open.startpos, to: open.endpos + 1, cls: "dj-defmark" });
      else out.push({ kind: "mark", from: open.startpos, to: open.endpos + 1, cls: "dj-listnum" });
    }
    if (blockNames.has(name)) {
      const cls = [`dj-${name}`];
      if (name === "heading") cls.push(`dj-h${text.slice(open.startpos).match(/^#+/)[0].length}`);
      if (name === "code_block") {
        const body = text.slice(text.indexOf("\n", open.startpos) + 1, end);
        if (/^#\|/.test(body)) cls.push("dj-chunk");
        let pos = text.indexOf("\n", open.startpos) + 1;
        for (const line of body.split("\n")) {
          if (/^#\|/.test(line))
            out.push({ kind: "mark", from: pos, to: pos + line.length, cls: "dj-chunkopt" });
          pos += line.length + 1;
        }
      }
      let lineEnd = end;
      if (name === "block_quote")
        while (lineEnd > open.startpos && text[lineEnd - 1] === "\n") lineEnd--;
      out.push({ kind: "line", from: open.startpos, to: lineEnd, cls: cls.join(" ") });
    }
  }
}
