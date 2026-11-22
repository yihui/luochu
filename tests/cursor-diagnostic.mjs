import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const port = 48772;
const binary = `/tmp/luochu-cursor-${process.pid}`;
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
let startupError = "";
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("server did not start")), 30000);
  server.stdout.on("data", (chunk) => {
    const match = chunk.toString().match(/token=([A-Za-z0-9_-]+)/);
    if (match) { token = match[1]; clearTimeout(timeout); resolve(); }
  });
  server.stderr.on("data", (chunk) => {
    startupError += chunk.toString();
    const match = chunk.toString().match(/token=([A-Za-z0-9_-]+)/);
    if (match) { token = match[1]; clearTimeout(timeout); resolve(); }
  });
  server.once("exit", (code) => reject(new Error(`server exited ${code}: ${startupError}`)));
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
await page.waitForFunction(() => document.querySelector("#preview-frame")?.dataset.ready === "true");
await page.locator("#mode-toggle").evaluate((button) => button.click());
await page.waitForTimeout(300);

const paragraphLine = page.getByText("Plain text with _emphasis_", { exact: false }).first();
const rect = await paragraphLine.boundingBox();
if (!rect) throw new Error("paragraph line was not visible");
await page.mouse.click(rect.x + 20, rect.y + rect.height / 2);
await page.waitForTimeout(50);
const result = await page.evaluate(() => ({
  selectionAnchor: window.__LUOCHU_EDITOR_VIEW__?.state.selection.main.anchor,
  selectionLine: window.__LUOCHU_EDITOR_VIEW__ ?
    window.__LUOCHU_EDITOR_VIEW__.state.doc.lineAt(
      window.__LUOCHU_EDITOR_VIEW__.state.selection.main.anchor,
    ).number : null,
  activeText: document.activeElement?.textContent?.slice(0, 40),
}));

console.log(JSON.stringify(result));
if (result.selectionLine !== 6) {
  throw new Error(`paragraph click landed on line ${result.selectionLine}, expected line 6`);
}
await browser.close();
server.kill("SIGTERM");
rmSync(binary, { force: true });
