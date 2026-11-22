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
process.once("exit", () => {
  server.kill("SIGTERM");
  rmSync(binary, { force: true });
});

let token = "";
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("server did not start")), 30000);
  const read = (chunk) => {
    const match = chunk.toString().match(/token=([A-Za-z0-9_-]+)/);
    if (match) {
      token = match[1];
      clearTimeout(timeout);
      resolve();
    }
  };
  server.stdout.on("data", read);
  server.stderr.on("data", read);
  server.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
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
await page.waitForFunction(() =>
  document.querySelector("#preview-frame")?.dataset.ready === "true",
);

const frame = page.frameLocator("#preview-frame");
const frameCount = await frame.locator("[data-startpos]").count();
if (frameCount < 10) throw new Error(`expected rendered preview blocks, got ${frameCount}`);

const sourceScroller = page.locator(".cm-scroller");
const sourceBeforeClick = await sourceScroller.evaluate((element) => element.scrollTop);
await frame.locator("[data-startpos]").nth(40).click();
await page.waitForTimeout(150);
const sourceAfterClick = await sourceScroller.evaluate((element) => element.scrollTop);

await sourceScroller.evaluate((element) => { element.scrollTop = element.scrollHeight * 0.4; });
await page.waitForTimeout(200);
const previewScrollAfterSource = await frame.locator("body").evaluate((body) =>
  body.ownerDocument.scrollingElement.scrollTop,
);

await frame.locator("html").evaluate((html) => {
  html.ownerDocument.scrollingElement.scrollTop = html.ownerDocument.scrollingElement.scrollHeight * 0.5;
});
await page.waitForTimeout(200);
const sourceScrollAfterPreview = await sourceScroller.evaluate((element) => element.scrollTop);

await page.locator("#mode-toggle").evaluate((button) => button.click());
await page.waitForTimeout(300);
const visualState = await page.locator(".cm-editor").evaluate((element) => ({
  visual: element.classList.contains("visual"),
  scrollerFont: getComputedStyle(element.querySelector(".cm-scroller")).fontFamily,
}));
await frame.locator("[data-startpos]").nth(40).click();
await page.waitForTimeout(150);
const revealedSourceFonts = await page.locator(".dj-source").evaluateAll((elements) =>
  elements.map((element) => getComputedStyle(element).fontFamily),
);
const visualCursorDiagnostic = await page.evaluate(() => {
  const editor = document.querySelector(".cm-content");
  if (!editor) return null;
  const lines = [...editor.querySelectorAll(".cm-line")];
  const line = lines.find((item) => {
    const rect = item.getBoundingClientRect();
    return rect.top >= 38 && rect.bottom <= window.innerHeight;
  });
  if (!line) return null;
  const rect = line.getBoundingClientRect();
  const x = rect.left + Math.min(20, rect.width - 1);
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    lineText: line.textContent,
    x,
    y,
    hitTag: hit?.tagName,
    hitClass: hit?.className,
  };
});
await page.locator(".cm-scroller").evaluate((element) => { element.scrollTop = 0; });
const headingFontSizes = await frame.locator("h1, h2, h3").evaluateAll((elements) =>
  elements.slice(0, 3).map((element) => getComputedStyle(element).fontSize),
);

const cspAndSandboxErrors = errors.filter((error) =>
  error.includes("Content Security Policy") ||
  error.includes("escape its sandboxing"),
);

console.log(JSON.stringify({
  frameCount,
  sourceBeforeClick,
  sourceAfterClick,
  previewScrollAfterSource,
  sourceScrollAfterPreview,
  visualState,
  revealedSourceFonts,
  headingFontSizes,
  visualCursorDiagnostic,
  cspAndSandboxErrors,
}));

await browser.close();
server.kill("SIGTERM");

if (sourceAfterClick === sourceBeforeClick) throw new Error("preview click did not reveal the source");
if (previewScrollAfterSource <= 0) throw new Error("source scroll did not scroll the preview");
if (sourceScrollAfterPreview <= 0) throw new Error("preview scroll did not scroll the source");
if (cspAndSandboxErrors.length) throw new Error(cspAndSandboxErrors.join("\n"));
