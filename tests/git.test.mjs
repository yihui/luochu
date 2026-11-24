import { test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { diffLineNumbers, diffLineTypes, splitCommitDiff, statusRows } from "../web/git.js";

test("diff gutters count old and new lines across hunks", () => {
  const diff = [
    "diff --git a/file b/file",
    "--- a/file",
    "+++ b/file",
    "@@ -2,3 +2,4 @@",
    " context",
    "-removed",
    "+added",
    "+another",
    " context",
    "@@ -20 +21 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
  ].join("\n") + "\n";
  deepStrictEqual(diffLineNumbers(diff), [
    { old: null, current: null }, { old: null, current: null }, { old: null, current: null },
    { old: null, current: null }, { old: 2, current: 2 }, { old: 3, current: null },
    { old: null, current: 3 }, { old: null, current: 4 }, { old: 4, current: 5 },
    { old: null, current: null }, { old: 20, current: null }, { old: null, current: 21 },
    { old: null, current: null },
  ]);
});

test("new-file and binary diffs have correct gutters", () => {
  deepStrictEqual(diffLineNumbers("@@ -0,0 +1,2 @@\n+first\n+second"), [
    { old: null, current: null }, { old: null, current: 1 }, { old: null, current: 2 },
  ]);
  deepStrictEqual(diffLineNumbers("Binary files a/file and b/file differ\n"), [{ old: null, current: null }]);
});

test("diff highlighting distinguishes headers from changed content across files", () => {
  const diff = [
    "commit message", "diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@",
    "--- removed text", "+++ added text", " context", "\\ No newline at end of file",
    "diff --git a/b b/b", "Binary files a/b and b/b differ",
  ].join("\n");
  deepStrictEqual(diffLineTypes(diff), [
    "", "header", "header", "header", "hunk", "removed", "added", "", "", "header", "",
  ]);
});

test("commit diffs split by file without confusing metadata or changed lines for headers", () => {
  const text = "commit abc\n\n    diff --git in a message\n\ndiff --git a/a b/a\n@@ -1 +1 @@\n" +
    "-diff --git a/old b/old\n+diff --git a/new b/new\ndiff --git a/b b/b\nBinary files differ\n";
  deepStrictEqual(splitCommitDiff(text, ["a", "new 名"]), {
    metadata: "commit abc\n\n    diff --git in a message\n\n",
    files: [
      { path: "a", text: "diff --git a/a b/a\n@@ -1 +1 @@\n-diff --git a/old b/old\n+diff --git a/new b/new\n" },
      { path: "new 名", text: "diff --git a/b b/b\nBinary files differ\n" },
    ],
  });
  deepStrictEqual(splitCommitDiff("commit empty\n", []), { metadata: "commit empty\n", files: [] });
  deepStrictEqual(splitCommitDiff(text, ["a"]), null);
});

test("status combines staged and unstaged changes by file", () => {
  const rows = statusRows([
    { path: "partial", xy: "MM", projectPath: "partial" },
    { path: "staged", xy: "M " },
    { path: "unstaged", xy: " M" },
    { path: "recreated", xy: "D " },
    { path: "recreated", xy: "??" },
    { path: "conflict", xy: "UU" },
  ]);
  deepStrictEqual(rows.map(({ path, staged, unstaged, status }) => ({ path, staged, unstaged, status })), [
    { path: "partial", staged: true, unstaged: true, status: "M" },
    { path: "staged", staged: true, unstaged: false, status: "M" },
    { path: "unstaged", staged: false, unstaged: true, status: "M" },
    { path: "recreated", staged: true, unstaged: true, status: "D?" },
    { path: "conflict", staged: false, unstaged: true, status: "UU" },
  ]);
});
