// Map djot parser events to editor spans. Pure (no DOM), so it also runs in Node.
import { isBlock, isInline, parse, parseEvents } from "@djot/djot";

// Explicit controls only: these annotations need editor-specific behavior.
const SKIP = new Set(["para", "list", "section"]),
  WHOLE = new Set([
    "attributes",
    "block_attributes",
    "destination",
    "reference",
  ]),
  LEAF_HIDE = new Set([
    "attr_class_marker",
    "attr_id_marker",
    "attr_equal_marker",
    "attr_space",
    "open_marker",
    "image_marker",
    "escape",
  ]),
  LEAF_SKIP = new Set(["str", "soft_break", "blankline", "hard_break"]);

const EVENT_TAGS = new Map([
  ["linktext", "link"],
  ["imagetext", "image"],
]);

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

// '+list|X' -> 'list', '-heading' -> 'heading'
const nameOf = (a) => a.slice(1).split("|")[0],
  subOf = (a) => a.split("|")[1];

// Spans: {kind, from, to, cls?}
//   'delim'  markup, hidden in visual mode
//   'mark'   styled content
//   'line'   block styling, applied to every line in [from, to)
//   'hr'     thematic break line
//   'bullet' unordered list marker (widget)
//   'check'  task checkbox (widget), `checked`
//   'image'  whole image (widget), `alt`, `src`
//   'table'  whole table (block widget)
export function tokenize(text) {
  const ast = parse(text, { sourcePositions: true }),
    inlineNames = collectTagNames(ast, isInline),
    blockNames = collectTagNames(ast, isBlock),
    out = [],
    stack = [],
    pairs = [];
  for (const e of parseEvents(text)) {
    const a = e.annot;
    if (a[0] === "+") stack.push({ name: nameOf(a), sub: subOf(a), ev: e });
    else if (a[0] === "-") {
      const name = nameOf(a);
      const i = stack.map((x) => x.name).lastIndexOf(name);
      if (i < 0) continue;
      const [o] = stack.splice(i, 1);
      pairs.push({ name, sub: o.sub, open: o.ev, close: e });
    } else leaf(e);
  }
  for (const o of stack)
    pairs.push({ name: o.name, sub: o.sub, open: o.ev, close: null });
  pairs.sort((x, y) => x.open.startpos - y.open.startpos);
  for (const p of pairs) pair(p);
  images(pairs);
  return out;

  function leaf(e) {
    const a = e.annot;
    const from = e.startpos,
      to = e.endpos + 1;
    if (LEAF_SKIP.has(a)) return;
    if (LEAF_HIDE.has(a)) return out.push({ kind: "delim", from, to });
    if (a === "thematic_break")
      return out.push({
        kind: "hr",
        from,
        to:
          from +
          text
            .slice(from)
            .match(/^[*-][*\- \t]*/)[0]
            .trimEnd().length,
      });
    if (a === "checkbox_checked" || a === "checkbox_unchecked")
      return out.push({
        kind: "check",
        from,
        to,
        checked: a === "checkbox_checked",
      });
    out.push({ kind: "mark", from, to, cls: "dj-" + a });
  }

  // `![alt](src)` as one unit: marker, imagetext pair, destination pair
  function images(ps) {
    for (const p of ps) {
      if (p.name !== "imagetext" || !p.close) continue;
      const dest = ps.find(
        (q) =>
          q.name === "destination" &&
          q.close &&
          q.open.startpos === p.close.endpos + 1,
      );
      const ref = ps.find(
        (q) =>
          q.name === "reference" &&
          q.close &&
          q.open.startpos === p.close.endpos + 1,
      );
      const tail = dest || ref;
      if (!tail || text[p.open.startpos - 1] !== "!") continue;
      const alt = text.slice(p.open.endpos + 1, p.close.startpos);
      const src = dest
        ? text
            .slice(dest.open.endpos + 1, dest.close.startpos)
            .trim()
            .split(/\s+/)[0]
        : "";
      out.push({
        kind: "image",
        from: p.open.startpos - 1,
        to: tail.close.endpos + 1,
        alt,
        src,
      });
    }
  }

  function pair({ name, sub, open, close }) {
    if (SKIP.has(name)) return;
    const end = close ? close.endpos + 1 : text.length;
    if (name === "block_attributes")
      return out.push({
        kind: "delim",
        from: open.startpos,
        to: close ? close.startpos : text.length,
      });
    if (WHOLE.has(name))
      return out.push({ kind: "delim", from: open.startpos, to: end });
    if (inlineNames.has(name) || inlineNames.has(EVENT_TAGS.get(name) || "")) {
      // a newline closer (heading) is the line end, not a delimiter
      const newlineClose = !close || text[close.startpos] === "\n";
      // heading opener is the '#'s plus trailing spaces
      const oTo =
        name === "heading"
          ? open.startpos +
            text.slice(open.startpos).match(/^#+[ \t]*/)[0].length
          : open.endpos + 1;
      out.push({ kind: "delim", from: open.startpos, to: oTo });
      const cTo = newlineClose
        ? close
          ? close.startpos
          : text.length
        : close.startpos;
      if (!newlineClose)
        out.push({ kind: "delim", from: close.startpos, to: close.endpos + 1 });
      if (cTo > oTo)
        out.push({ kind: "mark", from: oTo, to: cTo, cls: "dj-" + name });
    }
    if (blockNames.has(name) && (name === "code_block" || name === "div")) {
      out.push({ kind: "delim", from: open.startpos, to: open.endpos + 1 });
      if (close && /^[`:]/.test(text[close.startpos]))
        out.push({ kind: "delim", from: close.startpos, to: close.endpos + 1 });
    }
    if (name === "block_quote") {
      // continuation lines carry their own '>' markers
      let pos = open.startpos;
      while (pos < end) {
        const nl = text.indexOf("\n", pos);
        const m = text.slice(pos, nl < 0 ? end : nl).match(/^[ \t]*>[ ]?/);
        if (m)
          out.push({
            kind: "delim",
            from: pos + m[0].indexOf(">"),
            to: pos + m[0].length,
          });
        if (nl < 0) break;
        pos = nl + 1;
      }
    }
    if (name === "table") {
      let to = end;
      while (to > open.startpos && text[to - 1] === "\n") to--;
      out.push({ kind: "table", from: open.startpos, to });
    }
    if (name === "list_item") {
      const marker = text[open.startpos];
      if (sub === "X")
        out.push({ kind: "delim", from: open.startpos, to: open.endpos + 1 });
      else if (
        sub === "-" ||
        sub === "+" ||
        sub === "*" ||
        marker === "-" ||
        marker === "+" ||
        marker === "*"
      )
        out.push({ kind: "bullet", from: open.startpos, to: open.endpos + 1 });
      else if (sub === ":")
        out.push({
          kind: "mark",
          from: open.startpos,
          to: open.endpos + 1,
          cls: "dj-defmark",
        });
      else
        out.push({
          kind: "mark",
          from: open.startpos,
          to: open.endpos + 1,
          cls: "dj-listnum",
        });
    }
    if (blockNames.has(name)) {
      const cls = [`dj-${name}`];
      if (name === "heading")
        cls.push(`dj-h${text.slice(open.startpos).match(/^#+/)[0].length}`);
      if (name === "code_block") {
        const body = text.slice(text.indexOf("\n", open.startpos) + 1, end);
        if (/^#\|/.test(body)) cls.push("dj-chunk");
        // `#| key: value` lines are chunk options
        let pos = text.indexOf("\n", open.startpos) + 1;
        for (const ln of body.split("\n")) {
          if (/^#\|/.test(ln))
            out.push({
              kind: "mark",
              from: pos,
              to: pos + ln.length,
              cls: "dj-chunkopt",
            });
          pos += ln.length + 1;
        }
      }
      out.push({
        kind: "line",
        from: open.startpos,
        to: end,
        cls: cls.join(" "),
      });
    }
  }
}
