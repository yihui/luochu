import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tokenize } from "../web/tokens.js";
import { blockKey, sourceOffset } from "../web/preview-core.js";
import { renderDjotHTML } from "../web/render.js";

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

test("preview block keys and source offsets stay stable", () => {
  const element = {
    tagName: "P",
    getAttribute(name) {
      return name === "data-startpos" ? "1:1:0" : null;
    },
  };
  assert.equal(blockKey(element), "P:1:1:0");
  assert.equal(sourceOffset(element), 0);
});

test("loose task list checkbox is inside the first paragraph", () => {
  const html = renderDjotHTML(
    "- [ ] Open task\n\n  second line\n\n- [x] Completed task\n",
  );
  assert.match(html, /<li[^>]*>\n<p[^>]*><input[^>]*type="checkbox"\/> Open task/);
  assert.match(html, /<li[^>]*>\n<p[^>]*><input[^>]*checked=""[^>]*\/> Completed task/);
  assert.doesNotMatch(html, /<li>\n<input[^>]*>\n<p/);
});

