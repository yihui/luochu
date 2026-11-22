import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tokenize } from "../web/tokens.js";
import { blockKey, clampedScrollTop, sourceOffset } from "../web/preview-core.js";

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

test("preview scroll alignment clamps to the document bounds", () => {
  assert.equal(clampedScrollTop(120, 40, 1000), 80);
  assert.equal(clampedScrollTop(20, 40, 1000), 0);
  assert.equal(clampedScrollTop(1200, 40, 1000), 1000);
});


