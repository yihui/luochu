import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const port = 48771;
const binary = `/tmp/luochu-browser-test-${process.pid}`;
const build = spawnSync("go", ["build", "-o", binary, "./cmd/luochu"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
if (build.status !== 0) throw new Error(build.stderr);
const server = spawn(binary, ["-port", String(port), "-project", "."], {
  cwd: new URL("..", import.meta.url),
  stdio: ["ignore", "pipe", "pipe"],
});
let token = "";
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("server did not start")), 30000);
  server.stdout.on("data", (chunk) => {
    const match = chunk.toString().match(/token=([A-Za-z0-9_-]+)/);
    if (match) { token = match[1]; clearTimeout(timeout); resolve(); }
  });
  server.stderr.on("data", (chunk) => {
    const match = chunk.toString().match(/token=([A-Za-z0-9_-]+)/);
    if (match) { token = match[1]; clearTimeout(timeout); resolve(); }
  });
  server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    const text = message.text();
    if (!text.includes("placehold.co")) errors.push(text);
  }
});
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
await page.waitForTimeout(300);

const previewCount = await page.locator("#preview [data-startpos]").count();
if (previewCount < 10) throw new Error(`preview has only ${previewCount} blocks`);

await page.locator("#mode-toggle").evaluate((button) => button.click());
await page.waitForTimeout(300);
const visualState = await page.locator(".cm-editor").evaluate((element) => ({
  visual: element.classList.contains("visual"),
  scrollerFont: getComputedStyle(element.querySelector(".cm-scroller")).fontFamily,
}));

const paragraph = page.getByText("Plain text with _emphasis_", {exact: false}).first();
const rect = await paragraph.boundingBox();
if (!rect) throw new Error("paragraph line was not visible");
await page.mouse.click(rect.x + 20, rect.y + rect.height / 2);
await page.waitForTimeout(100);
const selection = await page.evaluate(() => ({
  anchor: window.__LUOCHU_EDITOR_VIEW__.state.selection.main.anchor,
  line: window.__LUOCHU_EDITOR_VIEW__.state.doc.lineAt(
    window.__LUOCHU_EDITOR_VIEW__.state.selection.main.anchor,
  ).number,
}));

console.log(JSON.stringify({previewCount, visualState, selection, errors}));
await browser.close();
server.kill("SIGTERM");
rmSync(binary, {force: true});

if (!visualState.visual) throw new Error("visual mode did not activate");
if (selection.line !== 6) throw new Error(`paragraph click landed on line ${selection.line}`);
if (errors.length) throw new Error(errors.join("\n"));
