import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tokenize } from "../web/tokens.js";
import { imageURL } from "../web/urls.js";

test("prototype Djot fixture produces stable span kinds", async () => {
  const text = await readFile(
    new URL("../web/demo.dj", import.meta.url),
    "utf8",
  );
  const tokens = tokenize(text);
  assert.ok(tokens.some((token) => token.kind === "line"));
  assert.ok(tokens.some((token) => token.kind === "check"));
  assert.ok(tokens.some((token) => token.kind === "mark"));
  assert.ok(tokens.every((token) => token.from >= 0 && token.to >= token.from));
});

test("nested and malformed Djot keeps source ranges valid", () => {
  const text = "_unterminated\n> quote\n- [ ] task\n``` r\nplot(",
    tokens = tokenize(text);
  assert.ok(tokens.every((token) => token.from >= 0 && token.to >= token.from));
});

test("math, numbered footnotes and table captions retain exact source ranges", () => {
  const text = "Math $`x^2` and [^n], then [^n].\n\n[^n]: note\n\n" +
    "| A | B |\n| - | - |\n| a | b |\n^ caption *bold*.\n",
    tokens = tokenize(text), math = tokens.find((token) => token.kind === "math"),
    refs = tokens.filter((token) => token.kind === "footnote"),
    label = tokens.find((token) => token.kind === "footnote_label"),
    table = tokens.find((token) => token.kind === "table");
  assert.equal(text.slice(math.from, math.to), "$`x^2`");
  assert.equal(math.expression, "x^2");
  assert.deepEqual(refs.map((ref) => ref.number), [1, 1]);
  assert.equal(refs[0].target, text.indexOf("[^n]:"));
  assert.equal(text.slice(label.from, label.to), "[^n]:");
  assert.ok(text.slice(table.from, table.to).endsWith("^ caption *bold*."));
});

test("image paths resolve against the document and reject unsafe protocols", () => {
  assert.equal(imageURL("../img/a.png", "chapters/page.dj"), "api/file?path=img%2Fa.png");
  assert.equal(imageURL("https://www.r-project.org/Rlogo.png", null),
    "https://www.r-project.org/Rlogo.png");
  assert.equal(imageURL("javascript:alert(1)", null), null);
  assert.equal(imageURL("", null), null);
});

test("raw HTML tokens include their inline format and complete block", () => {
  const text = "Inline `<b>safe</b>`{=html}.\n\n``` =html\n<p>safe</p>\n```\n",
    raw = tokenize(text).filter((token) => token.kind === "raw");
  assert.equal(raw.length, 2);
  assert.equal(text.slice(raw[0].from, raw[0].to), "`<b>safe</b>`{=html}");
  assert.equal(raw[0].html, "<b>safe</b>");
  assert.equal(text.slice(raw[1].from, raw[1].to), "``` =html\n<p>safe</p>\n```");
  assert.equal(raw[1].block, true);
});

