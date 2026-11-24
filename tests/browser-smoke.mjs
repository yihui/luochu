import { chromium } from "playwright";
import * as esbuild from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 48771, binary = `/tmp/luochu-browser-test-${process.pid}`,
  cwd = new URL("..", import.meta.url),
  build = spawnSync("go", ["build", "-o", binary, "./cmd/luochu"], {
    cwd, encoding: "utf8",
  });
if (build.status !== 0) throw new Error(build.stderr);

const server = spawn(binary, ["-port", String(port), "-project", ".", "-base-path", "/proxy"], {
  cwd, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  const token = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("server did not start")), 30000),
      read = (chunk) => {
        output += chunk.toString();
        const match = output.match(/token=([A-Za-z0-9_-]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      };
    server.stdout.on("data", read);
    server.stderr.on("data", read);
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited ${code}: ${output}`));
    });
  });

  browser = await chromium.launch({ headless: true });
  const noMathBundle = await esbuild.build({
    entryPoints: ["web/main.js"], bundle: true, format: "iife", write: false,
    loader: { ".dj": "text" }, external: ["./math.js", "./terminal.js", "./git.js"], minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "no-math-demo", setup(build) {
      build.onLoad({ filter: /demo\.dj$/ }, () => ({ contents: "A document without math.", loader: "text" }));
    } }],
  });
  const noMathPage = await browser.newPage(), mathRequests = [];
  await noMathPage.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { capabilities: { terminal: false } } }));
  noMathPage.on("request", (request) => {
    if (/\/assets\/math\.(js|css)$/.test(new URL(request.url()).pathname))
      mathRequests.push(request.url());
  });
  await noMathPage.route("**/assets/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: Buffer.from(noMathBundle.outputFiles[0].contents) }));
  await noMathPage.goto(`http://127.0.0.1:${port}/proxy/?token=${token}`, { waitUntil: "domcontentloaded" });
  await noMathPage.waitForFunction(() => window.__LUOCHU_EDITOR_VIEW__);
  await noMathPage.waitForTimeout(300);
  if (mathRequests.length) throw new Error("KaTeX loaded for a document without math");
  if (await noMathPage.locator("#terminal-controls").isVisible())
    throw new Error("Terminal controls are visible when the capability is absent");
  await noMathPage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "First edit." } });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Math $`x^2`." } });
  });
  await noMathPage.frameLocator("#preview-pane").locator("#preview .math .katex")
    .waitFor({ timeout: 5000 });
  if (mathRequests.length !== 2) throw new Error("KaTeX assets did not load when math appeared");
  await noMathPage.close();

  const treePage = await browser.newPage(), directoryRequests = [];
  let retryRequests = 0;
  await treePage.route("**/api/files?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    directoryRequests.push(path);
    if (path === "retry" && ++retryRequests === 1) {
      await route.fulfill({ status: 503, body: "unavailable" });
      return;
    }
    const directories = {
      "": [
        { name: "src", path: "src", type: "directory" },
        { name: "other", path: "other", type: "directory" },
        { name: "retry", path: "retry", type: "directory" },
        { name: "root.txt", path: "root.txt", type: "file" },
        { name: "document.dj", path: "document.dj", type: "file" },
        { name: "binary.dat", path: "binary.dat", type: "file" },
        { name: "document.pdf", path: "document.pdf", type: "file" },
        { name: "invalid.txt", path: "invalid.txt", type: "file" },
        { name: "late.bin", path: "late.bin", type: "file" },
        { name: "boundary.txt", path: "boundary.txt", type: "file" },
        { name: ".hidden", path: ".hidden", type: "file" },
      ],
      src: [
        { name: "nested", path: "src/nested", type: "directory" },
        { name: "one.txt", path: "src/one.txt", type: "file" },
      ],
      "src/nested": [{ name: "deep.txt", path: "src/nested/deep.txt", type: "file" }],
      other: [],
      retry: [{ name: "recovered.txt", path: "retry/recovered.txt", type: "file" }],
    };
    if (!Object.hasOwn(directories, path)) throw new Error(`Unexpected directory: ${path}`);
    await route.fulfill({ json: directories[path] });
  });
  const fileReads = [];
  let savedBody, savedPath, savedHash, releaseSave, saveStarted, saveConflict = false;
  await treePage.route("**/api/file?*", async (route) => {
    const params = new URL(route.request().url()).searchParams, path = params.get("path");
    if (route.request().method() === "PUT") {
      savedPath = path;
      savedBody = route.request().postData();
      savedHash = route.request().headers()["if-match"];
      await new Promise((resolve) => { releaseSave = resolve; saveStarted(); });
      return route.fulfill(saveConflict ? { status: 409 } : { headers: { "X-Luochu-Hash": "new-hash" } });
    }
    fileReads.push({ path, text: params.get("text") === "1" });
    if (["binary.dat", "document.pdf", "invalid.txt", "late.bin"].includes(path))
      return route.fulfill({ status: 415, body: path === "invalid.txt" ? "not UTF-8 text\n" : "binary file\n" });
    const body = path === "boundary.txt" ? "a".repeat(511) + "€\n"
      : path === "root.txt" ? "\ufeff# Not Djot\r\nsecond line\r\n"
      : path === "document.dj" ? "# Djot heading\n" : `Opened ${path}`;
    return route.fulfill({ body, headers: { "X-Luochu-Hash": "hash" } });
  });
  await treePage.goto(`http://127.0.0.1:${port}/proxy/?token=${token}`);
  const tree = treePage.locator("#file-tree"), srcFolder = tree.locator("details").filter({
    has: treePage.getByText("src", { exact: true }),
  });
  await tree.getByText("src", { exact: true }).click();
  await tree.getByText("nested", { exact: true }).click();
  await tree.getByText("deep.txt", { exact: true }).waitFor();
  const treeStyles = await tree.evaluate((element) => {
    const nodes = [element.querySelector("summary"), ...element.querySelectorAll(".file-tree-children summary"),
      ...element.querySelectorAll("button")];
    return nodes.map((node) => getComputedStyle(node).font);
  });
  if (treeStyles.some((font) => font !== treeStyles[0]))
    throw new Error(`Tree nodes lack consistent fonts: ${JSON.stringify(treeStyles)}`);
  if (!await tree.getByText("root.txt", { exact: true }).isVisible() ||
      await tree.getByText(".hidden", { exact: true }).count())
    throw new Error("Expanding a directory changed the root listing");
  await tree.getByText("other", { exact: true }).click();
  await tree.getByText("(empty)", { exact: true }).waitFor();
  await tree.getByText("src", { exact: true }).click();
  if (await tree.getByText("deep.txt", { exact: true }).isVisible())
    throw new Error("Collapsed folder still shows its descendants");
  await tree.getByText("src", { exact: true }).click();
  if (!await tree.getByText("deep.txt", { exact: true }).isVisible() ||
      !await srcFolder.locator("details").first().evaluate((element) => element.open) ||
      directoryRequests.filter((path) => path === "src" || path === "src/nested").length !== 2)
    throw new Error("Reopening a folder did not preserve its loaded subtree");
  await tree.getByText("retry", { exact: true }).click();
  await tree.getByText("Directory unavailable; close and reopen to retry").waitFor();
  await tree.getByText("retry", { exact: true }).click();
  await tree.getByText("retry", { exact: true }).click();
  await tree.getByText("recovered.txt", { exact: true }).waitFor();
  await tree.getByText("deep.txt", { exact: true }).click();
  await treePage.waitForFunction(() =>
    window.__LUOCHU_EDITOR_VIEW__.state.doc.toString() === "Opened src/nested/deep.txt");
  if (await treePage.title() !== "Luochu - src/nested/deep.txt")
    throw new Error("Opening a nested file did not use its full path");
  let dialogs = 0, acceptDiscard = false;
  treePage.on("dialog", async (dialog) => {
    dialogs++;
    if (acceptDiscard) await dialog.accept();
    else await dialog.dismiss();
  });
  if (await treePage.locator("#save-file").textContent() !== "Save")
    throw new Error("Opening a file marked it dirty");
  await tree.getByText("root.txt", { exact: true }).click();
  await treePage.waitForFunction(() => document.title === "Luochu - root.txt");
  if (dialogs || await treePage.locator("#save-file").textContent() !== "Save" ||
      await treePage.locator("#preview-pane").isVisible() ||
      await treePage.locator("#mode-toggle").isVisible() ||
      await treePage.locator("#editor .dj-heading").count())
    throw new Error("Switching an unchanged file prompted or marked it dirty");
  await treePage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: view.state.doc.length, insert: " edited" } });
  });
  if (await treePage.locator("#save-file").textContent() !== "Save*")
    throw new Error("Editing a file did not mark it dirty");
  await tree.getByText("deep.txt", { exact: true }).click();
  await treePage.waitForFunction(() => document.title === "Luochu - src/nested/deep.txt");
  if (dialogs || await treePage.locator("#file-tabs .file-tab").count() !== 2)
    throw new Error("Switching tabs prompted or duplicated an open file");
  await tree.getByText("root.txt", { exact: true }).click();
  await treePage.waitForFunction(() => document.title === "Luochu - root.txt");
  if (!await treePage.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString().endsWith(" edited")) ||
      await treePage.locator("#save-file").textContent() !== "Save*")
    throw new Error("Switching tabs lost the edited buffer");
  await treePage.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.focus());
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await treePage.keyboard.press(`${modifier}+z`);
  if (await treePage.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString().endsWith(" edited")))
    throw new Error("Undo history was lost when switching tabs");
  await treePage.keyboard.press(`${modifier}+Shift+z`);
  await treePage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nmore" } });
  });
  let saveStart = new Promise((resolve) => { saveStarted = resolve; });
  await treePage.locator("#save-file").click();
  await saveStart;
  await treePage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: view.state.doc.length, insert: " again" } });
  });
  await tree.getByText("deep.txt", { exact: true }).click();
  const saveResponse = treePage.waitForResponse((response) =>
    response.request().method() === "PUT" && response.url().includes("api/file"));
  releaseSave();
  await saveResponse;
  await tree.getByText("root.txt", { exact: true }).click();
  if (savedPath !== "root.txt" || savedHash !== "hash" ||
      savedBody !== "\ufeff# Not Djot\r\nsecond line\r\n edited\r\nmore" ||
      await treePage.locator("#save-file").textContent() !== "Save*")
    throw new Error("Saving lost line endings or edits made while saving");
  saveConflict = true;
  saveStart = new Promise((resolve) => { saveStarted = resolve; });
  await treePage.locator("#save-file").click();
  await saveStart;
  const conflictResponse = treePage.waitForResponse((response) =>
    response.request().method() === "PUT" && response.status() === 409);
  releaseSave();
  await conflictResponse;
  await treePage.getByText("Could not save root.txt: the file changed on disk.").waitFor();
  if (savedHash !== "new-hash" || await treePage.locator("#save-file").textContent() !== "Conflict")
    throw new Error("Disk conflict or updated save hash was lost");
  await tree.getByText("binary.dat", { exact: true }).click();
  await treePage.getByText("Cannot open binary.dat: binary file.").waitFor();
  await tree.getByText("document.pdf", { exact: true }).click();
  await treePage.getByText("Cannot open document.pdf: binary file.").waitFor();
  await tree.getByText("invalid.txt", { exact: true }).click();
  await treePage.getByText("Cannot open invalid.txt: not UTF-8 text.").waitFor();
  await tree.getByText("late.bin", { exact: true }).click();
  await treePage.getByText("Cannot open late.bin: binary file.").waitFor();
  if (fileReads.some((read) => !read.text) ||
      ["binary.dat", "document.pdf", "invalid.txt", "late.bin"].some((path) =>
        fileReads.filter((read) => read.path === path).length !== 1))
    throw new Error("Editor did not use a single server-validated text read");
  if (await treePage.title() !== "Luochu - root.txt" ||
      await treePage.locator("#file-tabs .file-tab").count() !== 2)
    throw new Error("Opening binary data changed the active tab");
  await tree.getByText("boundary.txt", { exact: true }).click();
  await treePage.waitForFunction(() => document.title === "Luochu - boundary.txt");
  if (!await treePage.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString().endsWith("€\n")))
    throw new Error("UTF-8 character split across the sniff boundary was rejected or lost");
  await treePage.getByRole("button", { name: "Close boundary.txt" }).click();
  await treePage.getByRole("button", { name: "Close root.txt" }).click();
  if (dialogs !== 1 || await treePage.title() !== "Luochu - root.txt")
    throw new Error("Canceling close did not preserve the dirty tab");
  acceptDiscard = true;
  await treePage.getByRole("button", { name: "Close root.txt" }).click();
  if (dialogs !== 2 || await treePage.title() !== "Luochu - src/nested/deep.txt")
    throw new Error("Discarding a dirty tab did not select the remaining tab");
  await tree.getByText("document.dj", { exact: true }).click();
  await treePage.waitForFunction(() => document.title === "Luochu - document.dj");
  await treePage.frameLocator("#preview-pane").getByRole("heading", { name: "Djot heading" }).waitFor();
  if (!await treePage.locator("#mode-toggle").isVisible())
    throw new Error("Djot controls were not restored for a Djot file");
  await treePage.setViewportSize({ width: 650, height: 750 });
  const layout = await treePage.evaluate(() => {
    const tabs = document.querySelector("#file-tabs").getBoundingClientRect(),
      editor = document.querySelector("#editor").getBoundingClientRect(),
      preview = document.querySelector("#preview-pane").getBoundingClientRect();
    return { tabs: tabs.bottom, editorTop: editor.top, editorBottom: editor.bottom, previewTop: preview.top };
  });
  if (layout.tabs > layout.editorTop || layout.editorBottom > layout.previewTop)
    throw new Error(`Mobile tabs, editor, and preview overlap: ${JSON.stringify(layout)}`);
  await treePage.close();

  const gitPage = await browser.newPage({ viewport: { width: 1100, height: 750 } }), gitRequests = [],
    diffRequests = [];
  await gitPage.clock.install();
  const numberedFixture = [
    "diff --git a/one.txt b/one.txt", "--- a/one.txt", "+++ b/one.txt", "@@ -2,3 +2,4 @@",
    " context", "-removed", `+added ${"x".repeat(500)}`, "+another", " context",
    "@@ -20 +21 @@", "-old", "+new", "\\ No newline at end of file",
  ].join("\n") + "\n";
  let staged = false, partialStatus = "MM", lastDiffVersion = 1, rejectNextStage = false, rejectNextStatus = false,
    pauseNextStatus = false, statusGate, releaseStatus, statusStarted;
  gitPage.on("request", (request) => {
    if (/\/assets\/git\.js$/.test(new URL(request.url()).pathname)) gitRequests.push("asset");
  });
  await gitPage.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { capabilities: { git: true, terminal: false } } }));
  await gitPage.route("**/api/files?*", (route) => {
    const dir = new URL(route.request().url()).searchParams.get("path");
    const entries = dir === "" ? ["one", "two"].map((name) => ({ name, path: name, type: "directory" }))
      : [{ name: `${dir}.txt`, path: `${dir}/${dir}.txt`, type: "file" }];
    return route.fulfill({ json: entries });
  });
  await gitPage.route("**/api/file?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const body = path === "one/one.txt"
      ? Array.from({ length: 30 }, (_, i) => `saved line ${i + 1}`).join("\n") : "saved file";
    return route.fulfill({ body, headers: { "X-Luochu-Hash": "hash" } });
  });
  await gitPage.route("**/api/git?*", async (route) => {
    const params = new URL(route.request().url()).searchParams, dir = params.get("dir");
    gitRequests.push(dir);
    if (route.request().method() === "POST") {
      if (rejectNextStage) {
        rejectNextStage = false;
        return route.fulfill({ status: 409, body: "index locked" });
      }
      const { path, action } = JSON.parse(route.request().postData());
      if (path === "file-0001.txt") partialStatus = action === "stage" ? "M " : " M";
      else staged = action === "stage";
      if (pauseNextStatus) {
        pauseNextStatus = false;
        statusGate = new Promise((resolve) => { releaseStatus = resolve; });
      }
      return route.fulfill({ status: 204 });
    }
    if (params.has("file")) {
      const file = params.get("file");
      diffRequests.push({ file, group: params.get("group") });
      if (file === "file-0001.txt") await new Promise((resolve) => setTimeout(resolve, 150));
      const body = file === "one.txt" ? numberedFixture : file === "file-1002.txt"
        ? `diff for ${file}\nlast diff version ${lastDiffVersion}` : file === "file-0002.txt"
        ? `diff for ${file}\n@@ -0,0 +1,150 @@\n${Array.from({ length: 150 }, (_, i) =>
          `+line ${i}${i === 0 ? "x".repeat(500) : ""}`).join("\n")}\n`
        : /^file-000[1-3]\.txt$/.test(file)
        ? `diff for ${file}\n${file === "file-0001.txt" ? `${params.get("group")} diff\n` : ""}${Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n")}`
        : `diff for ${file}`;
      return route.fulfill({ body });
    }
    if (!dir) return route.fulfill({ status: 404, body: "Not a Git repository" });
    if (statusGate) {
      const gate = statusGate;
      statusGate = null;
      statusStarted();
      await gate;
    }
    if (rejectNextStatus) {
      rejectNextStatus = false;
      return route.fulfill({ status: 503, body: "status unavailable" });
    }
    const changes = dir === "one" ? Array.from({ length: 1003 }, (_, i) => ({
      path: i === 3 ? "one.txt" : `file-${String(i).padStart(4, "0")}.txt`,
      projectPath: i === 2 ? undefined : `one/${i === 3 ? "one.txt" : `file-${String(i).padStart(4, "0")}.txt`}`,
      xy: i === 1 ? partialStatus : i === 0 && staged ? "M " : " M",
    })) : [{ path: "other.txt", projectPath: "other.txt", xy: "??" }];
    return route.fulfill({ json: { root: `/repos/${dir}`, relativeRoot: dir === "two" ? "." : dir, branch: dir, changes } });
  });
  await gitPage.goto(`http://127.0.0.1:${port}/proxy/?token=${token}`);
  await gitPage.locator("#git-toggle").waitFor({ state: "visible" });
  if (gitRequests.length) throw new Error("Git was loaded before opening its pane");
  await gitPage.locator("#file-tree").getByText("one", { exact: true }).click();
  await gitPage.locator("#file-tree").getByText("one.txt", { exact: true }).click();
  await gitPage.waitForFunction(() => document.title === "Luochu - one/one.txt");
  await gitPage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: view.state.doc.length, insert: " unsaved" } });
  });
  await gitPage.locator("#git-toggle").click();
  await gitPage.getByRole("link", { name: "M file-0002.txt", exact: true }).waitFor();
  const displayedRoot = gitPage.locator("#git-pane .git-root");
  if (await displayedRoot.textContent() !== "one" || await displayedRoot.getAttribute("title") !== "/repos/one" ||
      await gitPage.getByText("Git shows saved files", { exact: false }).count())
    throw new Error("Git repository label or reminder is incorrect");
  if (await gitPage.locator("#git-pane .git-row").count() > 120 ||
      await gitPage.locator("#git-pane .git-list [style]").count())
    throw new Error("Git status list was not virtualized");
  if (await gitPage.locator("#git-pane .git-row button").count() ||
      await gitPage.locator("#git-pane .git-row").first().evaluate((node) => node.getBoundingClientRect().height) >= 32)
    throw new Error("Git status rows are not compact or still use buttons");
  const partialCheckbox = gitPage.getByRole("checkbox", { name: "Stage file-0001.txt", exact: true });
  if (await gitPage.getByRole("link", { name: "M file-0001.txt", exact: true }).count() !== 1 ||
      !await partialCheckbox.evaluate((node) => node.indeterminate) ||
      await gitPage.locator("#git-pane").getByText(/^(Staged|Unstaged) \(\d+\)$/).count())
    throw new Error("Partially staged file is duplicated, not mixed, or still grouped");
  const badge = gitPage.getByRole("link", { name: "M file-0002.txt", exact: true }).locator(".git-status");
  if (await badge.textContent() !== "M" ||
      await badge.evaluate((node) => getComputedStyle(node).fontWeight) < 600)
    throw new Error("Git status character is not visually distinct");
  rejectNextStage = true;
  await gitPage.getByRole("checkbox", { name: "Stage file-0002.txt", exact: true }).click();
  await gitPage.getByText("Git operation failed: index locked", { exact: true }).waitFor();
  if (await gitPage.getByRole("checkbox", { name: "Stage file-0002.txt", exact: true }).isChecked())
    throw new Error("A failed stage left its checkbox checked");
  rejectNextStage = true;
  await partialCheckbox.click();
  await gitPage.getByText("Git operation failed: index locked", { exact: true }).waitFor();
  if (!await partialCheckbox.evaluate((node) => node.indeterminate))
    throw new Error("A failed stage did not restore the partially staged checkbox");
  await gitPage.getByRole("checkbox", { name: "Stage file-0000.txt", exact: true }).check();
  await gitPage.getByRole("checkbox", { name: "Unstage file-0000.txt", exact: true }).waitFor();
  await gitPage.getByRole("link", { name: "M file-0000.txt", exact: true }).click();
  await gitPage.getByText("diff for file-0000.txt", { exact: true }).waitFor();
  const shortSizing = await gitPage.getByText("diff for file-0000.txt", { exact: true }).evaluate((node) => {
    const scroll = node.closest(".git-diff-scroll");
    const text = scroll.querySelector(".git-diff-text"), gutters = scroll.querySelectorAll(".git-gutter");
    return { textRight: text.getBoundingClientRect().right, scrollRight: scroll.getBoundingClientRect().right,
      width: scroll.clientWidth, contentWidth: scroll.scrollWidth,
      background: getComputedStyle(text).backgroundColor,
      gutterBackgrounds: [...gutters].map((gutter) => getComputedStyle(gutter).backgroundColor) };
  });
  if (Math.abs(shortSizing.textRight - shortSizing.scrollRight) > 1 || shortSizing.contentWidth > shortSizing.width + 1)
    throw new Error(`Short diff does not fill the available width: ${JSON.stringify(shortSizing)}`);
  if (shortSizing.background !== "rgba(0, 0, 0, 0)" ||
      shortSizing.gutterBackgrounds.some((background) => background === "rgba(0, 0, 0, 0)"))
    throw new Error(`Diff text or gutters have the wrong background: ${JSON.stringify(shortSizing)}`);
  if (await gitPage.locator("#git-diff .git-diff-file").count() !== 1003 ||
      await gitPage.locator("#git-diff h3").filter({ hasText: "file-0001.txt" }).count() !== 1)
    throw new Error("Review does not have exactly one diff for each file");
  if (diffRequests.length > 40 || diffRequests.some(({ file }) => file === "file-1002.txt"))
    throw new Error("Off-screen diffs were loaded eagerly");
  await gitPage.getByRole("link", { name: "M file-0001.txt", exact: true }).click();
  await gitPage.getByRole("heading", { name: "file-0001.txt", exact: true }).waitFor();
  await gitPage.getByText("diff for file-0001.txt", { exact: true }).waitFor();
  if (!diffRequests.some(({ file, group }) => file === "file-0001.txt" && group === "unstaged") ||
      diffRequests.some(({ file, group }) => file === "file-0001.txt" && group === "staged"))
    throw new Error("A partially staged file did not use the index-to-working-tree diff");
  await gitPage.evaluate(() => {
    const list = document.querySelector("#git-pane .git-list"),
      row = [...list.querySelectorAll(".git-row")].find((item) => item.textContent.includes("file-0000.txt")),
      section = [...document.querySelectorAll("#git-diff .git-diff-file")]
        .find((item) => item.querySelector("h3").textContent.endsWith("file-0000.txt"));
    window.__gitTest = { row, section, source: section.querySelector("pre"), listScroll: list.scrollTop,
      diffScroll: document.querySelector("#git-diff-content").scrollTop };
  });
  const firstDiffRequests = diffRequests.filter(({ file }) => file === "file-0000.txt").length,
    statusStart = new Promise((resolve) => { statusStarted = resolve; });
  pauseNextStatus = true;
  await partialCheckbox.click();
  await statusStart;
  const requestsWhileBusy = gitRequests.length;
  await gitPage.clock.fastForward(5000);
  if (gitRequests.length !== requestsWhileBusy)
    throw new Error("Automatic refresh ran during a Git operation");
  if (!await gitPage.evaluate(() => window.__gitTest.row.isConnected &&
      window.__gitTest.section.isConnected && window.__gitTest.source.isConnected))
    throw new Error("Git status or unrelated diff disappeared while the status refreshed");
  releaseStatus();
  await gitPage.getByRole("checkbox", { name: "Unstage file-0001.txt", exact: true }).waitFor();
  await gitPage.getByText("staged diff", { exact: true }).waitFor();
  const kept = await gitPage.evaluate(() => {
    const { row, section, source, listScroll, diffScroll } = window.__gitTest;
    return { row: row.isConnected, section: section.isConnected, source: source.isConnected,
      focus: document.activeElement?.getAttribute("aria-label") === "Unstage file-0001.txt",
      listScroll: document.querySelector("#git-pane .git-list").scrollTop - listScroll,
      diffScroll: document.querySelector("#git-diff-content").scrollTop - diffScroll };
  });
  if (!kept.row || !kept.section || !kept.source || !kept.focus || kept.listScroll || kept.diffScroll ||
      diffRequests.filter(({ file }) => file === "file-0000.txt").length !== firstDiffRequests)
    throw new Error(`Staging unnecessarily rebuilt or moved the Git pane: ${JSON.stringify(kept)}`);
  rejectNextStatus = true;
  await gitPage.getByRole("checkbox", { name: "Unstage file-0001.txt", exact: true }).click();
  await gitPage.getByText("Could not refresh Git status: status unavailable", { exact: true }).waitFor();
  await gitPage.getByRole("checkbox", { name: "Unstage file-0001.txt", exact: true }).click();
  await gitPage.getByText("Git status is stale; refresh before staging or unstaging.", { exact: true }).waitFor();
  await gitPage.getByRole("button", { name: "Refresh", exact: true }).click();
  await gitPage.getByRole("checkbox", { name: "Stage file-0001.txt", exact: true }).waitFor();
  await gitPage.getByRole("link", { name: "M file-0002.txt", exact: true }).click();
  const selectedDiff = gitPage.locator("#git-diff .git-diff-file").filter({
    has: gitPage.getByRole("heading", { name: "file-0002.txt", exact: true }),
  });
  await gitPage.waitForFunction(() => [...document.querySelectorAll("#git-diff pre")]
    .some((node) => node.textContent.includes("diff for file-0002.txt\n") && node.textContent.includes("line 149")));
  const longSizing = await selectedDiff.locator(".git-diff-scroll").evaluate((scroll) => {
    const rows = scroll.querySelectorAll(".git-diff-row"), firstLine = rows[2].querySelector(".git-diff-line"),
      nextLine = rows[3].querySelector(".git-diff-line"), nextNumber = rows[3].querySelector("button");
    return {
      width: scroll.clientWidth, contentWidth: scroll.scrollWidth, height: firstLine.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(firstLine).lineHeight), nextHeight: nextLine.getBoundingClientRect().height,
      alignment: Math.abs(nextLine.getBoundingClientRect().top - nextNumber.getBoundingClientRect().top),
    };
  });
  if (longSizing.contentWidth > longSizing.width + 1 || longSizing.height < longSizing.lineHeight * 2 ||
      longSizing.nextHeight > longSizing.lineHeight * 1.1 || longSizing.alignment > 3)
    throw new Error(`Long diff did not wrap with aligned gutters: ${JSON.stringify(longSizing)}`);
  if (!await selectedDiff.getByRole("button", { name: "Open file-0002.txt at line 1", exact: true }).isDisabled())
    throw new Error("A file outside the project root has a clickable line number");
  await gitPage.waitForTimeout(300);
  const selectedTop = await selectedDiff.locator("summary").evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    viewport: node.closest("#git-diff-content").getBoundingClientRect().top,
  }));
  if (Math.abs(selectedTop.top - selectedTop.viewport) > 2)
    throw new Error(`Clicking a status path did not navigate to its diff: ${JSON.stringify(selectedTop)}`);
  const diffBounds = await gitPage.locator("#git-diff-content").boundingBox();
  await gitPage.mouse.move(diffBounds.x + diffBounds.width / 2, diffBounds.y + 120);
  await gitPage.mouse.wheel(0, 250);
  await gitPage.waitForTimeout(150);
  const sticky = await selectedDiff.locator("summary").evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    viewport: node.closest("#git-diff-content").getBoundingClientRect().top,
    sectionTop: node.parentElement.getBoundingClientRect().top,
  }));
  if (sticky.sectionTop >= sticky.viewport || Math.abs(sticky.top - sticky.viewport) > 2)
    throw new Error(`Diff heading did not stick while scrolling: ${JSON.stringify(sticky)}`);
  await selectedDiff.locator("summary").click();
  if (await selectedDiff.evaluate((node) => node.open) || await selectedDiff.locator(".git-diff-text").isVisible())
    throw new Error("Clicking a diff heading did not fold its content");
  await selectedDiff.locator("summary").click();
  if (!await selectedDiff.evaluate((node) => node.open) || !await selectedDiff.locator(".git-diff-text").isVisible())
    throw new Error("Clicking a folded diff heading did not reopen it");
  await gitPage.setViewportSize({ width: 600, height: 700 });
  await gitPage.getByRole("link", { name: "M one.txt", exact: true }).click();
  const numberedDiff = gitPage.locator("#git-diff .git-diff-file").filter({
    has: gitPage.getByRole("heading", { name: "one.txt", exact: true }),
  });
  await numberedDiff.getByRole("button", { name: "Open one.txt at line 21", exact: true }).waitFor();
  const gutters = await numberedDiff.evaluate((node) => {
    const rows = [...node.querySelectorAll(".git-diff-row")], source = node.querySelector(".git-diff-text"),
      scroll = node.querySelector(".git-diff-scroll"), wrapped = rows[6].querySelector(".git-diff-line"),
      text = rows[11].querySelector(".git-diff-line").firstChild, range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const line = range.getBoundingClientRect(), number = rows[11].querySelector("button").getBoundingClientRect(),
      selection = window.getSelection(), selected = document.createRange();
    selected.selectNodeContents(source);
    selection.removeAllRanges();
    selection.addRange(selected);
    const copied = selection.toString();
    selection.removeAllRanges();
    return {
      old: rows.map((row) => row.querySelector(".git-old-gutter").dataset.line || ""),
      current: rows.map((row) => row.querySelector("button")?.dataset.line || ""),
      oldButtons: node.querySelectorAll(".git-old-gutter button").length,
      styles: [rows[11].querySelector(".git-old-gutter"), rows[11].querySelector(".git-new-gutter"),
        rows[11].querySelector(".git-diff-line")].map((element) => getComputedStyle(element).lineHeight),
      alignment: Math.abs((line.top + line.bottom - number.top - number.bottom) / 2),
      copied, raw: source.textContent, width: scroll.clientWidth, contentWidth: scroll.scrollWidth,
      wrappedHeight: wrapped.getBoundingClientRect().height,
    };
  });
  if (gutters.old[4] !== "2" || gutters.old[5] !== "3" || gutters.old[6] !== "" ||
      gutters.current[4] !== "2" || gutters.current[5] !== "" || gutters.current[6] !== "3" ||
      gutters.current[11] !== "21" || gutters.oldButtons || new Set(gutters.styles).size !== 1 ||
      gutters.alignment > 2 || gutters.width + 1 < gutters.contentWidth ||
      gutters.wrappedHeight < parseFloat(gutters.styles[0]) * 2 ||
      gutters.raw !== numberedFixture || gutters.copied !== numberedFixture.replace(/\n$/, ""))
    throw new Error(`Diff line-number gutters are incorrect: ${JSON.stringify(gutters)}`);
  await numberedDiff.getByRole("button", { name: "Open one.txt at line 21", exact: true }).click();
  const jump = await gitPage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { line: view.state.doc.lineAt(view.state.selection.main.head).number,
      dirty: view.state.doc.toString().endsWith(" unsaved") };
  });
  if (jump.line !== 21 || !jump.dirty || await gitPage.locator("#git-diff").isVisible())
    throw new Error(`New-line navigation lost the dirty buffer or landed incorrectly: ${JSON.stringify(jump)}`);
  await gitPage.setViewportSize({ width: 1100, height: 750 });
  await gitPage.getByRole("link", { name: "M file-0002.txt", exact: true }).click();
  await gitPage.locator("#git-diff-content").hover();
  await gitPage.mouse.wheel(0, 100);
  await gitPage.locator("#git-diff-content").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await gitPage.getByText("diff for file-1002.txt", { exact: true }).waitFor();
  if (!diffRequests.some(({ file }) => file === "file-1002.txt"))
    throw new Error("Scrolling did not load the final diff");
  await gitPage.locator("#git-diff-content").evaluate((node) => { node.scrollTop = 0; });
  await gitPage.waitForTimeout(100);
  lastDiffVersion = 2;
  const lastRequests = diffRequests.filter(({ file }) => file === "file-1002.txt").length,
    polledStatus = gitPage.waitForResponse((response) =>
      response.request().method() === "GET" && response.url().includes("api/git?") &&
      !new URL(response.url()).searchParams.has("file"));
  await gitPage.clock.fastForward(5000);
  await polledStatus;
  await gitPage.waitForTimeout(100);
  if (diffRequests.filter(({ file }) => file === "file-1002.txt").length !== lastRequests)
    throw new Error("Automatic refresh loaded an off-screen diff");
  await gitPage.locator("#git-diff-content").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await gitPage.getByText("last diff version 2", { exact: true }).waitFor();
  await gitPage.getByRole("button", { name: "Close Git diff" }).click();
  if (!await gitPage.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString().endsWith(" unsaved")))
    throw new Error("Git diff lost the dirty editor buffer");
  await gitPage.getByRole("checkbox", { name: "Unstage file-0000.txt", exact: true }).uncheck();
  await gitPage.getByRole("checkbox", { name: "Stage file-0000.txt", exact: true }).waitFor();
  const gitList = gitPage.locator("#git-pane .git-list");
  await gitList.evaluate((node) => { node.scrollTop = node.scrollHeight / 2; });
  await gitPage.getByRole("link", { name: "M file-0500.txt", exact: true }).waitFor();
  if (await gitList.locator(".git-row").count() > 160)
    throw new Error("Scrolling rendered too many Git status rows");
  await gitList.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const lastLink = gitPage.getByRole("link", { name: "M file-1002.txt", exact: true });
  await lastLink.waitFor();
  const lastGap = await lastLink.evaluate((node) =>
    node.closest(".git-list").getBoundingClientRect().bottom - node.closest(".git-row").getBoundingClientRect().bottom);
  if (Math.abs(lastGap) > 2) throw new Error(`The last Git page has extra space: ${lastGap}`);
  await lastLink.click();
  await gitPage.getByText("diff for file-1002.txt", { exact: true }).waitFor();
  const selectedPosition = await gitPage.locator("#git-diff h3").filter({ hasText: "file-1002.txt" })
    .evaluate((node) => {
      const bounds = node.getBoundingClientRect(), viewport = node.closest("#git-diff-content").getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.top < viewport.bottom;
    });
  if (!selectedPosition) throw new Error("Review did not navigate to the selected file");
  await gitPage.getByRole("button", { name: "Close Git diff" }).click();
  await gitPage.locator("#files-toggle").click();
  await gitPage.locator("#file-tree").getByText("two", { exact: true }).click();
  await gitPage.locator("#file-tree").getByText("two.txt", { exact: true }).click();
  await gitPage.waitForFunction(() => document.title === "Luochu - two/two.txt");
  await gitPage.locator("#git-toggle").click();
  await gitPage.getByRole("link", { name: "? other.txt" }).waitFor();
  if (await displayedRoot.isVisible()) throw new Error("Project-root repository should not show a path");
  await gitPage.locator("#file-tabs").getByRole("button", { name: "one.txt *" }).click();
  await gitPage.getByRole("link", { name: "M file-0002.txt", exact: true }).waitFor();
  await gitPage.setViewportSize({ width: 600, height: 700 });
  await gitPage.getByRole("link", { name: "M file-0000.txt", exact: true }).click();
  if (!await gitPage.locator("#git-diff").isVisible())
    throw new Error("Git diff is not visible at narrow width");
  await gitPage.close();

  if (spawnSync("git", ["--version"]).status === 0) {
    const fixture = mkdtempSync(join(tmpdir(), "luochu-git-browser-"));
    let gitServer;
    try {
      for (const name of ["first", "second"]) {
        const dir = join(fixture, name);
        mkdirSync(dir);
        const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
        if (init.status !== 0) throw new Error(init.stderr);
        writeFileSync(join(dir, `${name}.txt`), `${name} content\n`);
      }
      const firstRepo = join(fixture, "first");
      writeFileSync(join(firstRepo, "committed.txt"), "committed content\n");
      for (const args of [
        ["add", "committed.txt"],
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "history fixture"],
      ]) {
        const result = spawnSync("git", ["-C", firstRepo, ...args], { encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stderr);
      }
      gitServer = spawn(binary, ["-port", "0", "-project", fixture, "-base-path", "/proxy"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const gitURL = await new Promise((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Git fixture server did not start")), 30000),
          read = (chunk) => {
            output += chunk.toString();
            const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/proxy\/\?token=[A-Za-z0-9_-]+/);
            if (match) { clearTimeout(timeout); resolve(match[0]); }
          };
        gitServer.stdout.on("data", read);
        gitServer.stderr.on("data", read);
        gitServer.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Git fixture server exited ${code}: ${output}`));
        });
      });
      const realGitPage = await browser.newPage(), realStatusRequests = [];
      await realGitPage.clock.install();
      realGitPage.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/api/git") && !url.searchParams.has("file") &&
            request.method() === "GET") realStatusRequests.push(url.searchParams.get("dir"));
      });
      await realGitPage.goto(gitURL);
      await realGitPage.locator("#file-tree").getByText("first", { exact: true }).click();
      await realGitPage.locator("#git-toggle").click();
      await realGitPage.getByRole("link", { name: "? first.txt" }).click();
      await realGitPage.getByText("+first content", { exact: false }).waitFor();
      const tabBar = realGitPage.locator("#file-tabs");
      if (await tabBar.getByRole("button", { name: "Git diff", exact: true }).getAttribute("aria-pressed") !== "true" ||
          await realGitPage.locator("#editor").isVisible() || await realGitPage.locator("#preview-pane").isVisible() ||
          await realGitPage.getByRole("button", { name: "Close diff", exact: true }).count())
        throw new Error("Diff tab does not exclusively display the Git diff");
      await realGitPage.getByRole("button", { name: "History", exact: true }).click();
      await realGitPage.locator("#git-history").getByRole("button", { name: /history fixture/ }).click();
      await realGitPage.locator("#git-history-diff").getByText("+committed content", { exact: false }).waitFor();
      const historyColors = await realGitPage.locator("#git-history").evaluate((node) => ({
        list: getComputedStyle(node.querySelector("#git-history-list")).backgroundColor,
        diff: getComputedStyle(node.querySelector("#git-history-diff")).backgroundColor,
      }));
      if (historyColors.list === "rgba(0, 0, 0, 0)" || historyColors.diff !== "rgba(0, 0, 0, 0)")
        throw new Error(`Incorrect Git history backgrounds: ${JSON.stringify(historyColors)}`);
      if (await tabBar.getByRole("button", { name: "Git history", exact: true }).getAttribute("aria-pressed") !== "true" ||
          await realGitPage.locator("#editor").isVisible() || await realGitPage.locator("#git-diff").isVisible() ||
          !await realGitPage.getByRole("button", { name: "Save", exact: true }).isDisabled())
        throw new Error("History tab does not exclusively display Git history");
      await tabBar.getByRole("button", { name: "Git diff", exact: true }).click();
      await realGitPage.getByText("+first content", { exact: false }).waitFor();
      await tabBar.getByRole("button", { name: "Git history", exact: true }).click();
      await realGitPage.locator("#git-history").getByRole("button", { name: /history fixture/ }).waitFor();
      await tabBar.getByRole("button", { name: "Close Git history", exact: true }).click();
      await realGitPage.getByText("+first content", { exact: false }).waitFor();
      await tabBar.getByRole("button", { name: "Close Git diff", exact: true }).click();
      if (!await realGitPage.locator("#editor").isVisible() || !await realGitPage.locator("#preview-pane").isVisible())
        throw new Error("Closing Git tabs did not restore the demo");
      await realGitPage.getByRole("button", { name: "History", exact: true }).click();
      await realGitPage.locator("#git-history").getByRole("button", { name: /history fixture/ }).waitFor();
      await realGitPage.getByRole("link", { name: "? first.txt" }).click();
      await realGitPage.getByText("+first content", { exact: false }).waitFor();
      await realGitPage.getByRole("button", { name: "Open first.txt at line 1", exact: true }).click();
      await realGitPage.waitForFunction(() => document.title === "Luochu - first/first.txt");
      await realGitPage.evaluate(() => {
        const view = window.__LUOCHU_EDITOR_VIEW__;
        view.dispatch({ changes: { from: view.state.doc.length, insert: "unsaved edit" } });
      });
      await tabBar.getByRole("button", { name: "Git history", exact: true }).click();
      await realGitPage.locator("#git-history").getByRole("button", { name: /history fixture/ }).waitFor();
      await tabBar.getByRole("button", { name: "Git diff", exact: true }).click();
      await realGitPage.getByText("+first content", { exact: false }).waitFor();
      await realGitPage.locator("#files-toggle").click();
      await tabBar.getByRole("button", { name: "first.txt *", exact: true }).click();
      if (!await realGitPage.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString().endsWith("unsaved edit")))
        throw new Error("Switching Git tabs lost unsaved file edits");
      await tabBar.getByRole("button", { name: "Git diff", exact: true }).click();
      await realGitPage.getByText("+first content", { exact: false }).waitFor();
      await realGitPage.locator("#git-toggle").click();
      await realGitPage.getByRole("link", { name: "? first.txt" }).click();
      await realGitPage.getByRole("checkbox", { name: "Stage first.txt", exact: true }).check();
      await realGitPage.getByRole("checkbox", { name: "Unstage first.txt", exact: true }).waitFor();
      if (!await realGitPage.locator("#git-diff").isVisible())
        throw new Error("Staging closed the diff review");
      const stagedStatus = spawnSync("git", ["-C", join(fixture, "first"), "status", "--porcelain"], {
        encoding: "utf8",
      });
      if (!stagedStatus.stdout.startsWith("A  first.txt"))
        throw new Error(`Real Git stage failed: ${stagedStatus.stdout} ${stagedStatus.stderr}`);
      const stagedDiff = realGitPage.locator("#git-diff .git-diff-file").filter({
        has: realGitPage.getByRole("heading", { name: "first.txt", exact: true }),
      });
      await stagedDiff.getByRole("button", { name: "Open first.txt at line 1", exact: true }).click();
      await realGitPage.getByRole("link", { name: "A first.txt", exact: true }).click();
      writeFileSync(join(fixture, "first", "first.txt"), "first content\nmodified again\n");
      await realGitPage.clock.fastForward(5000);
      const partial = realGitPage.getByRole("checkbox", { name: "Stage first.txt", exact: true });
      await partial.waitFor({ timeout: 10000 });
      const partialDiff = realGitPage.locator("#git-diff .git-diff-file").filter({
        has: realGitPage.getByRole("heading", { name: "first.txt", exact: true }),
      });
      await partialDiff.getByText("+modified again", { exact: false }).waitFor();
      if (!await partial.evaluate((node) => node.indeterminate) ||
          await realGitPage.getByRole("link", { name: "AM first.txt", exact: true }).count() !== 1 ||
          await realGitPage.locator("#git-diff h3").filter({ hasText: "first.txt" }).count() !== 1 ||
          await partialDiff.getByText("+first content", { exact: false }).count())
        throw new Error("Real partially staged file did not show only its working-tree changes");
      await partial.focus();
      await partial.evaluate((node) => { window.__gitUnchangedRow = node.closest(".git-row"); });
      await partialDiff.locator("pre").evaluate((node) => { window.__gitUnchangedDiff = node; });
      const unchangedDiffResponse = realGitPage.waitForResponse((response) =>
        response.url().includes("api/git?") && new URL(response.url()).searchParams.get("file") === "first.txt");
      await realGitPage.clock.fastForward(5000);
      await unchangedDiffResponse;
      await realGitPage.waitForTimeout(100);
      if (!await realGitPage.evaluate(() => window.__gitUnchangedDiff.isConnected &&
          window.__gitUnchangedRow.isConnected && window.__gitUnchangedRow.contains(document.activeElement)))
        throw new Error("Automatic refresh rebuilt unchanged Git content or lost focus");
      writeFileSync(join(fixture, "first", "first.txt"), "first content\nmodified again\nmodified yet again\n");
      await realGitPage.clock.fastForward(5000);
      await partialDiff.getByText("+modified yet again", { exact: false }).waitFor({ timeout: 10000 });
      if (!await partial.evaluate((node) => node.indeterminate))
        throw new Error("Refreshing an already-modified file changed its staging state");
      writeFileSync(join(fixture, "first", "new.txt"), "new file\n");
      await realGitPage.clock.fastForward(5000);
      await realGitPage.getByRole("link", { name: "? new.txt", exact: true }).waitFor({ timeout: 10000 });
      await partial.click();
      await realGitPage.getByRole("checkbox", { name: "Unstage first.txt", exact: true }).waitFor();
      const stagedAgain = spawnSync("git", ["-C", join(fixture, "first"), "show", ":first.txt"], { encoding: "utf8" });
      if (stagedAgain.status !== 0 || stagedAgain.stdout !== "first content\nmodified again\nmodified yet again\n")
        throw new Error(`Partially staged file was not fully staged: ${stagedAgain.stdout} ${stagedAgain.stderr}`);
      await realGitPage.getByRole("checkbox", { name: "Unstage first.txt", exact: true }).uncheck();
      await realGitPage.getByRole("checkbox", { name: "Stage first.txt", exact: true }).waitFor();
      await realGitPage.locator("#files-toggle").click();
      const inactiveRequests = realStatusRequests.length;
      await realGitPage.clock.fastForward(10000);
      await realGitPage.waitForTimeout(100);
      if (realStatusRequests.length !== inactiveRequests)
        throw new Error("Git status was polled while its pane was hidden");
      writeFileSync(join(fixture, "first", "while-hidden.txt"), "hidden change\n");
      await realGitPage.locator("#git-toggle").click();
      await realGitPage.getByRole("link", { name: "? while-hidden.txt", exact: true }).waitFor();
      await realGitPage.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      });
      const backgroundRequests = realStatusRequests.length;
      await realGitPage.clock.fastForward(10000);
      await realGitPage.waitForTimeout(100);
      if (realStatusRequests.length !== backgroundRequests)
        throw new Error("Git status was polled while the browser tab was hidden");
      writeFileSync(join(fixture, "first", "background.txt"), "background change\n");
      await realGitPage.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await realGitPage.getByRole("link", { name: "? background.txt", exact: true }).waitFor();
      await realGitPage.locator("#files-toggle").click();
      await realGitPage.locator("#file-tree").getByText("second", { exact: true }).click();
      await realGitPage.locator("#git-toggle").click();
      await realGitPage.getByRole("link", { name: "? second.txt" }).waitFor();
      await realGitPage.locator("#files-toggle").click();
      await realGitPage.locator("#project-root").click();
      await realGitPage.locator("#git-toggle").click();
      await realGitPage.getByText("Not a Git repository", { exact: true }).waitFor();
      await realGitPage.locator("#file-tabs").getByRole("button", { name: "first.txt *", exact: true }).click();
      await realGitPage.getByRole("link", { name: "? first.txt" }).waitFor();
      await realGitPage.close();
    } finally {
      if (gitServer && gitServer.exitCode === null && gitServer.signalCode === null) {
        const stopped = new Promise((resolve) => gitServer.once("exit", resolve));
        gitServer.kill("SIGTERM");
        await stopped;
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } }), errors = [];
  let terminalSocket, terminalConnections = 0;
  await page.routeWebSocket(/\/api\/terminal(?:\?|$)/, (socket) => {
    terminalSocket = socket;
    terminalConnections++;
    socket.connectToServer();
  });
  const imageBody = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120; canvas.height = 100;
    canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  let imageRequest, unsafeRequest = false;
  const terminalRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("attacker.invalid")) unsafeRequest = true;
    if (/\/assets\/terminal\.(js|css)$/.test(new URL(request.url()).pathname))
      terminalRequests.push(request.url());
  });
  await page.route("https://attacker.invalid/**", (route) => route.abort());
  await page.route("https://www.r-project.org/Rlogo.png", async (route) => {
    imageRequest = route.request();
    await route.fulfill({ contentType: "image/png", body: imageBody });
  });
  await page.route("**/api/file?path=images%2Flocal.png", async (route) => {
    await route.fulfill({ contentType: "application/octet-stream", body: imageBody,
      headers: { "X-Content-Type-Options": "nosniff" } });
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/proxy/?token=${token}`);
  await page.waitForFunction(() => window.__LUOCHU_EDITOR_VIEW__);
  const preview = page.frameLocator("#preview-pane");
  await preview.locator("#preview [data-startpos]").first().waitFor();

  const previewCount = await preview.locator("#preview [data-startpos]").count();
  if (previewCount < 10) throw new Error(`preview has only ${previewCount} blocks`);
  const demoImage = await preview.locator("#preview img").first().getAttribute("src");
  if (demoImage !== "https://www.r-project.org/Rlogo.png")
    throw new Error(`Demo preview image URL is incorrect: ${demoImage}`);
  const isolation = await page.evaluate(() => {
    const frame = document.querySelector("#preview-pane"), script = frame.contentDocument.createElement("script");
    script.textContent = "parent.__sandboxExecuted = true";
    frame.contentDocument.body.append(script);
    script.remove();
    return { sandbox: frame.getAttribute("sandbox"), executed: !!window.__sandboxExecuted,
      outside: !!document.querySelector("#preview") };
  });
  if (isolation.sandbox !== "allow-same-origin" || isolation.executed || isolation.outside)
    throw new Error(`Preview is not isolated: ${JSON.stringify(isolation)}`);
  const blockedScript = errors.findIndex((error) =>
    error.includes("Blocked script execution") && error.includes("sandboxed"));
  if (blockedScript < 0) throw new Error("Sandbox did not report blocking the injected script");
  errors.splice(blockedScript, 1);
  const previewLink = preview.locator("a").filter({ hasText: "djot site" });
  const expectedLink = Number((await previewLink.getAttribute("data-startpos")).split(":")[2]);
  await previewLink.click();
  const linkResult = await page.evaluate(() => ({
    selection: window.__LUOCHU_EDITOR_VIEW__.state.selection.main.head,
    url: document.querySelector("#preview-pane").contentWindow.location.href,
  }));
  if (linkResult.selection !== expectedLink || linkResult.url !== "about:srcdoc")
    throw new Error(`Preview link click did not reveal source safely: ${JSON.stringify(linkResult)}`);

  const demo = await page.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString()),
    quote = "# Quote\n\n> first line\n> second line\n\nAfter quote.\n";
  async function checkLineNumbers() {
    await page.waitForFunction(() => {
      const gutter = [...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement")],
        lines = [...document.querySelectorAll(".cm-line")];
      return ["Plain text with", "O and E=mc"].every((text, index) => {
        const line = lines.find((node) => node.textContent.includes(text)),
          number = gutter.find((node) => node.textContent === String(index + 5));
        return line && number && Math.abs(line.getBoundingClientRect().top -
          number.getBoundingClientRect().top) <= 3;
      });
    });
  }
  await checkLineNumbers();
  for (const visual of [false, true]) {
    if (visual) await page.locator("#mode-toggle").click();
    await page.evaluate((text) => {
      const view = window.__LUOCHU_EDITOR_VIEW__;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 } });
    }, quote);
    if (await page.locator(".cm-line.dj-block_quote").count() !== 2)
      throw new Error(`Blockquote decorates the trailing blank line in ${visual ? "visual" : "source"} mode`);
    await page.evaluate(() => {
      const view = window.__LUOCHU_EDITOR_VIEW__;
      view.dispatch({ selection: { anchor: view.state.doc.line(5).from } });
      view.focus();
    });
    await page.keyboard.press("Backspace");
    const actual = await page.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString());
    if (actual !== quote.replace("> second line\n\n", "> second line\n"))
      throw new Error(`Cannot delete the blank line after the blockquote in ${visual ? "visual" : "source"} mode`);
    await page.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((node) =>
        node.textContent.includes("After quote.")),
        number = [...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
          .find((node) => node.textContent === "5");
      return line && number && Math.abs(line.getBoundingClientRect().top -
        number.getBoundingClientRect().top) <= 3;
    });
  }
  await page.locator("#mode-toggle").click();
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, demo);
  await page.locator("#mode-toggle").click();
  const demoSmart = await page.locator(".cm-line").filter({ hasText: "right here. Smart" }).textContent();
  if (!demoSmart.includes("Smart “quotes”, it’s, dashes – en and — em, and ellipsis…"))
    throw new Error(`Demo smart punctuation is incorrect: ${demoSmart}`);
  await checkLineNumbers();

  async function clickText(text, index) {
    const target = await page.evaluate(async ({ text, index }) => {
      const view = window.__LUOCHU_EDITOR_VIEW__, expected = view.state.doc.toString().indexOf(text);
      if (expected < 0) throw new Error(`Missing source text: ${text}`);
      const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.data.indexOf(text);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start + index);
        range.setEnd(node, start + index + 1);
        for (let attempt = 0; attempt < 10; attempt++) {
          node.parentElement.closest(".cm-line").scrollIntoView({ block: "center" });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const rect = range.getBoundingClientRect(), bounds = view.scrollDOM.getBoundingClientRect();
          if (rect.top >= bounds.top && rect.bottom <= bounds.bottom)
            return { x: rect.left + rect.width * 0.25, y: (rect.top + rect.bottom) / 2,
              expected: expected + index };
        }
        throw new Error(`Could not scroll "${text}" into view`);
      }
      throw new Error(`Missing visible text node: ${text}`);
    }, { text, index });
    await page.mouse.click(target.x, target.y);
    const actual = await page.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.selection.main.head);
    if (actual !== target.expected && actual !== target.expected + 1)
      throw new Error(`Click on "${text}" at ${target.expected} landed at ${actual}`);
  }

  await clickText("Plain text with ", 5);
  await clickText("right here. Smart ", 4);
  await clickText("Inline marks", 4);
  await clickText("A paragraph with block attributes above it.", 9);
  const font = await page.locator(".cm-editor").evaluate((element) => ({
    visual: element.classList.contains("visual"),
    scroller: getComputedStyle(element.querySelector(".cm-scroller")).fontFamily,
    content: getComputedStyle(element.querySelector(".cm-content")).fontFamily,
  }));
  if (!font.visual || !font.scroller.includes("system-ui") || !font.content.includes("system-ui"))
    throw new Error(`visual font or mode lost after clicking: ${JSON.stringify(font)}`);

  const longLine = "Wrapped paragraph " + "many words make this line wrap across the editor ".repeat(5),
    deepLines = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nParagraph ${i}.\n`).join("\n");
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, `# Heading one\n\n## Heading two\n\nLink [label](https://example.com/a/very/long/url) after link.\n\n${longLine}\n\n### Heading three\n\nFinal paragraph here.\n\n${deepLines}\nDeep target paragraph.\n`);

  const linkGap = await page.locator(".cm-line").filter({ hasText: "after link." }).evaluate((line) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), positions = {};
    let node;
    while ((node = walker.nextNode())) {
      for (const text of ["label", " after link."]) {
        const index = node.data.indexOf(text);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        positions[text] = range.getBoundingClientRect().toJSON();
      }
    }
    return { gap: positions[" after link."].left - positions.label.right,
      vertical: positions[" after link."].top - positions.label.top };
  });
  if (Math.abs(linkGap.vertical) > 1 || linkGap.gap < 0 || linkGap.gap > 5)
    throw new Error(`Hidden link markup leaves space: ${JSON.stringify(linkGap)}`);
  await clickText("label", 2);
  const revealed = await page.locator(".cm-line").filter({ hasText: "after link." }).textContent();
  if (!revealed.includes("(https://example.com/a/very/long/url)"))
    throw new Error("Active link line did not reveal its source");
  await clickText(longLine, 10);
  await clickText(longLine, 100);
  await clickText(longLine, 200);
  await clickText("Final paragraph here.", 8);
  await clickText("Heading three", 5);

  await page.evaluate(() => {
    const scroller = window.__LUOCHU_EDITOR_VIEW__.scrollDOM;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForFunction(() => document.querySelector(".cm-content").textContent
    .includes("Deep target paragraph."));
  await clickText("Deep target paragraph.", 8);
  await page.waitForFunction(() =>
    document.querySelector("#preview-pane").contentWindow.scrollY > 0);

  const margins = await page.locator(".cm-line").evaluateAll((lines) => lines.map((line) => ({
    text: line.textContent, top: parseFloat(getComputedStyle(line).marginTop),
    bottom: parseFloat(getComputedStyle(line).marginBottom),
  })).filter((line) => line.top || line.bottom));
  if (margins.length) throw new Error(`Editor lines have vertical margins: ${JSON.stringify(margins)}`);

  const fixture = [
    "# Widgets", "",
    "{+added+} {-removed-} H~2~O E=mc^2^ and `code`.",
    "Inline math $`x^2 + 1`.",
    "Display math $$`\\frac{1}{2}`.",
    "Untrusted math $`\\href{javascript:alert(1)}{bad}`.",
    "", "- first bullet", "- [ ] open task", "- [x] done task", "",
    "Image ![R logo](https://www.r-project.org/Rlogo.png).",
    "Local ![local](images/local.png).",
    "A footnote[^note].", "",
    "| Left | Right |", "|:-----|------:|", "| apple | pear |", "",
    'Inline `<b class="raw-safe" onclick="window.__pwned=1" ' +
      'style="background:url(https://attacker.invalid/leak)">raw inline</b>' +
      '<a class="bad-link" href="javascript:alert(1)">bad</a>' +
      '<script>window.__pwned=2</script>`{=html}', "",
    "``` =html",
    '<div class="raw-block" onclick="window.__pwned=3"><strong>raw block</strong>' +
      '<script>window.__pwned=4</script></div>',
    "```", "",
    "After table text.", "", "[^note]: Footnote body.",
  ].join("\n");
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, fixture);
  await page.waitForSelector(".dj-math .katex");
  if (await page.locator(".dj-math .katex").count() !== 3)
    throw new Error("inline and display math did not render");
  await preview.locator("#preview .math.display .mfrac").waitFor();
  const previewMathFont = await preview.locator("#preview .math .katex").first()
    .evaluate((node) => getComputedStyle(node).fontFamily);
  if (!previewMathFont.includes("KaTeX"))
    throw new Error(`Preview math stylesheet was not applied: ${previewMathFont}`);
  if (await page.locator(".dj-math .katex-error").count())
    throw new Error("Valid math did not render correctly");
  if (await page.locator('.katex a[href^="javascript:"]').count())
    throw new Error("Untrusted math created an unsafe link");
  await page.locator(".dj-math").first().click();
  let clicked = await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { actual: view.state.selection.main.head, expected: view.state.doc.toString().indexOf("$`x^2 + 1`"),
      source: view.contentDOM.textContent };
  });
  if (clicked.actual !== clicked.expected || !clicked.source.includes("$`x^2 + 1`"))
    throw new Error(`Math click did not reveal its source: ${JSON.stringify(clicked)}`);
  const styles = await page.locator(".cm-content").evaluate((content) => {
    const css = (selector, property) => getComputedStyle(content.querySelector(selector))[property];
    return { insert: css(".dj-insert", "textDecorationLine"),
      delete: css(".dj-delete", "textDecorationLine"), sub: css(".dj-subscript", "verticalAlign"),
      sup: css(".dj-superscript", "verticalAlign"), code: css(".dj-verbatim", "fontFamily") };
  });
  if (!styles.insert.includes("underline") || !styles.delete.includes("line-through") ||
    styles.sub !== "sub" || styles.sup !== "super" || !styles.code.includes("monospace"))
    throw new Error(`Inline styles missing: ${JSON.stringify(styles)}`);
  await clickText("added", 2);
  await clickText("removed", 3);
  await clickText("code", 1);
  if (await page.locator(".dj-bullet").count() !== 1)
    throw new Error("Bullet marker did not render");
  const checks = page.locator(".dj-check");
  if (await checks.count() !== 2 || await checks.nth(0).isChecked() ||
    !(await checks.nth(1).isChecked())) throw new Error("Task boxes did not render correctly");
  await checks.nth(0).click();
  const changed = await page.evaluate(() => window.__LUOCHU_EDITOR_VIEW__.state.doc.toString());
  if (changed !== fixture.replace("- [ ] open task", "- [x] open task"))
    throw new Error("Task click changed unrelated source");
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(".dj-image img")];
    return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5000 }).catch(async (error) => {
    const images = await page.locator(".dj-image img").evaluateAll((nodes) =>
      nodes.map((img) => ({ src: img.src, complete: img.complete, width: img.naturalWidth })));
    throw new Error(`Images did not load: ${JSON.stringify(images)}; ${error.message}`);
  });
  if (!imageRequest || imageRequest.headers().referer)
    throw new Error("External image failed or sent a referrer");
  await page.waitForFunction(() => {
    const images = [...document.querySelector("#preview-pane").contentDocument.querySelectorAll("#preview img")];
    return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5000 });
  await page.locator('.dj-image img[alt="R logo"]').click();
  clicked = await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { actual: view.state.selection.main.head, expected: view.state.doc.toString().indexOf("![R logo]"),
      source: view.contentDOM.textContent };
  });
  if (clicked.actual !== clicked.expected || !clicked.source.includes("![R logo](https://www.r-project.org/Rlogo.png)"))
    throw new Error(`Image click did not reveal its source: ${JSON.stringify(clicked)}`);
  if (await page.locator(".dj-footnote-ref").textContent() !== "1")
    throw new Error("Footnote reference did not render");
  if (await page.locator(".dj-footnote-label").textContent() !== "1.")
    throw new Error("Footnote definition number did not render");
  await page.locator(".dj-footnote-ref").click();
  const footnotePosition = await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { actual: view.state.selection.main.head, expected: view.state.doc.toString().indexOf("[^note]:") };
  });
  if (footnotePosition.actual !== footnotePosition.expected)
    throw new Error(`Footnote link jumped to ${footnotePosition.actual}, expected ${footnotePosition.expected}`);
  if (await page.locator(".dj-table-widget td").count() !== 2 ||
    (await page.locator(".dj-table-widget").textContent()).indexOf("apple") < 0)
    throw new Error("Table did not render");
  if (await page.locator(".dj-raw-html .raw-safe").textContent() !== "raw inline" ||
    await page.locator(".dj-raw-html .raw-block strong").textContent() !== "raw block")
    throw new Error("Sanitized raw HTML did not render");
  const unsafe = await page.evaluate(() => ({
    executed: window.__pwned,
    elements: [document, document.querySelector("#preview-pane").contentDocument].reduce((count, doc) =>
      count + doc.querySelectorAll(".dj-raw-html script, #preview script, " +
        ".raw-safe[onclick], .raw-safe[style], .raw-block[onclick], .bad-link[href^='javascript:']").length, 0),
  }));
  if (unsafe.executed || unsafe.elements || unsafeRequest)
    throw new Error(`Unsafe raw HTML was retained: ${JSON.stringify(unsafe)}`);
  await clickText("After table text.", 5);
  await page.locator(".dj-raw-html .raw-block strong").click();
  if (!(await page.locator(".cm-content").textContent()).includes('class="raw-block"'))
    throw new Error("Clicking raw HTML did not reveal its source");
  await clickText("After table text.", 5);
  await page.locator(".dj-table-widget td").first().click();
  if (!(await page.locator(".cm-content").textContent()).includes("| apple | pear |"))
    throw new Error("Clicking a table did not reveal its source");

  await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, insert: "New preceding text.\n\n" },
      selection: { anchor: 0 } });
  });
  await page.locator(".dj-math").first().click();
  let position = await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { actual: view.state.selection.main.head, expected: view.state.doc.toString().indexOf("$`x^2 + 1`") };
  });
  if (position.actual !== position.expected) throw new Error("Math click used an outdated source position");
  await clickText("After table text.", 5);
  await page.locator('.dj-image img[alt="R logo"]').click();
  position = await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { actual: view.state.selection.main.head, expected: view.state.doc.toString().indexOf("![R logo]") };
  });
  if (position.actual !== position.expected) throw new Error("Image click used an outdated source position");

  await page.locator("#mode-toggle").click();
  await clickText("After table text.", 5);
  const sourceFont = await page.locator(".cm-scroller").evaluate((scroller) =>
    getComputedStyle(scroller).fontFamily);
  if (!sourceFont.includes("monospace")) throw new Error(`Source font changed: ${sourceFont}`);
  await page.evaluate(() => { window.__LUOCHU_EDITOR_VIEW__.scrollDOM.scrollTop = 0; });
  await page.waitForSelector(".dj-insert");
  const sourceStyles = await page.locator(".dj-insert").evaluate((node) =>
    getComputedStyle(node).textDecorationLine);
  if (!sourceStyles.includes("underline")) throw new Error("Source-mode inline styles are missing");

  await page.locator("#mode-toggle").click();
  const visualFixture = [
    "Baseline first", "", "Baseline second", "",
    'Smart "quotes", it\'s, dashes -- en and --- em, and ellipsis...', "",
    "{.lead}", "{#id}", "Attributed paragraph.", "",
    "```js", "code body one", "code body two", "```", "",
    "::: warning", "div body text", ":::", "",
    "***", "", ": Term", "", "  Definition text.", "", "After marker.",
  ].join("\n");
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, visualFixture);
  const smart = await page.locator(".cm-line").filter({ hasText: "Smart" }).textContent();
  if (smart !== "Smart “quotes”, it’s, dashes – en and — em, and ellipsis…")
    throw new Error(`Smart punctuation is incorrect: ${JSON.stringify(smart)}`);
  if (await page.locator(".dj-hr-widget").count() !== 1)
    throw new Error("Horizontal rule is not rendered");
  const termWeight = await page.locator(".dj-term").evaluate((node) =>
    Number(getComputedStyle(node).fontWeight));
  if (termWeight < 600) throw new Error("Definition term is not styled");
  if ((await page.locator(".dj-term").locator("..").textContent()) !== "Term")
    throw new Error("Definition marker leaves extra space");

  const gaps = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    function rect(text) {
      const line = lines.find((node) => node.textContent.includes(text));
      if (!line) throw new Error(`Missing editor line: ${text}`);
      return line.getBoundingClientRect();
    }
    return {
      baseline: rect("Baseline second").top - rect("Baseline first").bottom,
      attributes: rect("Attributed paragraph.").top - rect("Smart ").bottom,
      openingFence: rect("code body one").top - rect("Attributed paragraph.").bottom,
      closingFence: rect("div body text").top - rect("code body two").bottom,
    };
  });
  for (const [name, gap] of Object.entries(gaps)) {
    if (name !== "baseline" && Math.abs(gap - gaps.baseline) > 3)
      throw new Error(`${name} leaves excess whitespace: ${JSON.stringify(gaps)}`);
  }
  if (!await page.locator(".cm-line").filter({ hasText: "code body one" })
    .evaluate((line) => line.classList.contains("dj-code_block")))
    throw new Error("Hiding the opening fence lost the code block styling");
  await page.locator(".dj-punctuation").first().click();
  const quotePosition = await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    return { actual: view.state.selection.main.head, expected: view.state.doc.toString().indexOf('"quotes"') };
  });
  if (quotePosition.actual !== quotePosition.expected)
    throw new Error("Clicking a smart quote did not reveal its source position");
  await clickText("Attributed paragraph.", 5);
  let visible = await page.locator(".cm-content").textContent();
  if (!visible.includes("{.lead}") || !visible.includes("{#id}"))
    throw new Error("Clicking the paragraph did not reveal its block attributes");
  await clickText("code body one", 5);
  visible = await page.locator(".cm-content").textContent();
  if (!visible.includes("```js") || !visible.includes("```"))
    throw new Error("Clicking the code block did not reveal its fences");
  await clickText("div body text", 5);
  visible = await page.locator(".cm-content").textContent();
  if (!visible.includes("::: warning") || !visible.includes(":::"))
    throw new Error("Clicking the div did not reveal its fences");
  await page.locator(".dj-hr-widget").click();
  if (!(await page.locator(".cm-content").textContent()).includes("***"))
    throw new Error("Clicking the rule did not reveal its source");

  await page.locator("#mode-toggle").click();
  const source = await page.locator(".cm-content").textContent();
  if (!source.includes("{.lead}") || !source.includes("```js") || !source.includes("::: warning"))
    throw new Error("Source mode must retain attribute and fence lines");

  await page.locator("#mode-toggle").click();
  const nested = [
    "Start", "", "{.panel}", "", "::: info", "Nested before", "",
    "```r", "nested code body", "```", ":::", "",
    "```js", "```", "", "::: note", ":::", "", "After empty blocks.",
  ].join("\n");
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, nested);
  if (await page.locator(".dj-empty-block").count() !== 2)
    throw new Error("Empty code and div blocks need clickable placeholders");
  const preservedBlanks = await page.locator(".cm-line").evaluateAll((lines) => {
    const first = lines.findIndex((line) => line.textContent === "Start"),
      last = lines.findIndex((line) => line.textContent === "Nested before");
    return lines.slice(first + 1, last).filter((line) => !line.textContent).length;
  });
  if (preservedBlanks !== 2)
    throw new Error(`Explicit blank lines around attributes were lost: ${preservedBlanks}`);
  visible = await page.locator(".cm-content").textContent();
  if (visible.includes("{.panel}") || visible.includes("```") || visible.includes(":::"))
    throw new Error("Inactive nested attributes or fences are visible");
  await clickText("After empty blocks.", 5);
  await page.getByText("Empty code block", { exact: true }).click();
  if (!(await page.locator(".cm-content").textContent()).includes("```js"))
    throw new Error("Empty code block did not reveal its fences");
  await clickText("After empty blocks.", 5);
  await page.getByText("Empty div", { exact: true }).click();
  if (!(await page.locator(".cm-content").textContent()).includes("::: note"))
    throw new Error("Empty div did not reveal its fences");
  await clickText("nested code body", 5);
  visible = await page.locator(".cm-content").textContent();
  if (!visible.includes("{.panel}") || !visible.includes("::: info") || !visible.includes("```r"))
    throw new Error("Clicking nested code did not reveal its owning attributes and fences");

  const quotedFence = "Start\n\n> ```r\n> quoted code body\n> ```\n\nAfter quoted code.\n";
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, quotedFence);
  if ((await page.locator(".cm-content").textContent()).includes("```"))
    throw new Error("Nested quoted code fences are visible");
  await clickText("quoted code body", 5);
  if (!(await page.locator(".cm-content").textContent()).includes("```r"))
    throw new Error("Clicking quoted code did not reveal its fences");
  await clickText("After quoted code.", 5);

  await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__, text = "Start\n\n```r\n";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  });
  await page.getByText("Empty code block", { exact: true }).click();
  if (!(await page.locator(".cm-content").textContent()).includes("```r"))
    throw new Error("Empty unclosed code block did not reveal its fence");

  const rawSpacing = [
    "Baseline first", "", "Baseline second", "", "``` =html",
    '<div class="raw">passed through for HTML only</div>', "```", "", "## Divs", "",
    "After raw block.",
  ].join("\n");
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, rawSpacing);
  const rawGeometry = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")],
      first = lines.find((line) => line.textContent === "Baseline first"),
      second = lines.find((line) => line.textContent === "Baseline second"),
      heading = lines.find((line) => line.textContent.includes("Divs")),
      raw = document.querySelector("div.dj-raw-html");
    return {
      lineHeight: first.getBoundingClientRect().height,
      rawHeight: raw.getBoundingClientRect().height,
      baselineGap: second.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
      rawGap: heading.getBoundingClientRect().top - raw.getBoundingClientRect().bottom,
    };
  });
  if (Math.abs(rawGeometry.rawHeight - rawGeometry.lineHeight) > 2 ||
    Math.abs(rawGeometry.rawGap - rawGeometry.baselineGap) > 2)
    throw new Error(`Raw HTML block has extra whitespace: ${JSON.stringify(rawGeometry)}`);
  await page.waitForFunction(() => {
    const heading = [...document.querySelectorAll(".cm-line")].find((node) =>
      node.textContent.includes("Divs")),
      number = [...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
        .find((node) => node.textContent === "9");
    return heading && number && Math.abs(heading.getBoundingClientRect().top -
      number.getBoundingClientRect().top) <= 3;
  });
  await clickText("After raw block.", 5);
  await page.locator(".dj-raw-html .raw").click();
  if (!(await page.locator(".cm-content").textContent()).includes('``` =html'))
    throw new Error("Clicking raw HTML did not reveal its source");
  await clickText("After raw block.", 5);
  await clickText("Divs", 2);

  const multilineRaw = [
    "Start", "", "``` =html", '<div class="first">First</div>',
    '<div class="second">Second</div>', "<pre>  a\n  b</pre>", "```", "", "End",
  ].join("\n");
  await page.evaluate((text) => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 } });
  }, multilineRaw);
  const rawContent = await page.locator("div.dj-raw-html").evaluate((raw) => {
    const first = raw.querySelector(".first"), second = raw.querySelector(".second"),
      pre = raw.querySelector("pre");
    return { gap: second.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
      whiteSpace: getComputedStyle(pre).whiteSpace, text: pre.textContent };
  });
  if (Math.abs(rawContent.gap) > 2 || rawContent.whiteSpace !== "pre" ||
    rawContent.text !== "  a\n  b")
    throw new Error(`Raw HTML whitespace was not rendered correctly: ${JSON.stringify(rawContent)}`);
  await page.locator("#terminal-controls").waitFor({ state: "visible" });
  if (terminalRequests.length) throw new Error("Terminal assets loaded before the terminal was opened");
  if (await page.locator("#terminal-controls select").count())
    throw new Error("Terminal controls should not offer command selection");
  await page.locator("#terminal-toggle").click();
  await page.waitForFunction(() => document.querySelector("#terminal-status").textContent.startsWith("Connected."))
    .catch(async (error) => { throw new Error(`${error.message}: ${await page.locator("#terminal-status").textContent()}`); });
  if (terminalRequests.length !== 2) throw new Error(`Terminal assets did not load lazily: ${terminalRequests}`);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("sh -c 'printf \"browser-test-%s\\n\" ready'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".xterm-rows").textContent.includes("browser-test-ready"));
  await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__, text = "printf 'paste-test-%s\\n' ready";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0, head: text.length } });
  });
  await page.locator("#terminal-paste").click();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".xterm-rows").textContent.includes("paste-test-ready"));
  await page.keyboard.type("export LUOCHU_RECONNECT=preserved");
  await page.keyboard.press("Enter");
  await page.keyboard.type("printf 'before-reconnect-%s\\n' \"$LUOCHU_RECONNECT\"");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".xterm-rows").textContent.includes("before-reconnect-preserved"));
  await terminalSocket.close({ code: 1001, reason: "test disconnect" });
  await page.waitForFunction(() => document.querySelector("#terminal-status").textContent.includes("reconnecting"));
  await page.waitForFunction(() => document.querySelector("#terminal-status").textContent.startsWith("Connected."))
    .catch(async (error) => { throw new Error(`${error.message}: ${await page.locator("#terminal-status").textContent()}`); });
  if (terminalConnections < 2) throw new Error("Terminal did not reconnect");
  await page.waitForFunction(() =>
    document.querySelector(".xterm-rows").textContent.includes("before-reconnect-preserved"));
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'after-reconnect-%s\\n' \"$LUOCHU_RECONNECT\"");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".xterm-rows").textContent.includes("after-reconnect-preserved"));
  await page.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__, text = "blocked-command-one\nblocked-command-two";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0, head: text.length } });
  });
  let confirmed = false;
  page.once("dialog", async (dialog) => { confirmed = true; await dialog.dismiss(); });
  await page.locator("#terminal-paste").click();
  if (!confirmed || (await page.locator(".xterm-rows").textContent()).includes("blocked-command"))
    throw new Error("Multiline paste was not guarded by confirmation");
  await page.locator("#terminal-toggle").click();
  if (await page.locator("#terminal-pane").isVisible())
    throw new Error("Closing the terminal did not hide the pane");
  await page.locator("#terminal-toggle").click();
  await page.waitForFunction(() => document.querySelector("#terminal-status").textContent.startsWith("Connected."));
  if (terminalRequests.length !== 2) throw new Error("Reopening terminal reloaded its assets");
  await page.locator("#terminal-toggle").click();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Browser smoke: visual widgets, sanitized HTML, cursor clicks and proxy paths passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  rmSync(binary, { force: true });
}
