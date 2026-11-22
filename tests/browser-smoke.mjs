import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const port = 48771, binary = `/tmp/luochu-browser-test-${process.pid}`,
  cwd = new URL("..", import.meta.url),
  build = spawnSync("go", ["build", "-o", binary, "./cmd/luochu"], {
    cwd, encoding: "utf8",
  });
if (build.status !== 0) throw new Error(build.stderr);

const server = spawn(binary, ["-port", String(port), "-project", "."], {
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } }), errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("placehold.co"))
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await page.waitForFunction(() => window.__LUOCHU_EDITOR_VIEW__);

  const previewCount = await page.locator("#preview [data-startpos]").count();
  if (previewCount < 10) throw new Error(`preview has only ${previewCount} blocks`);
  await page.locator("#mode-toggle").click();

  async function clickText(text, index) {
    const target = await page.evaluate(async ({ text, index }) => {
      const view = window.__LUOCHU_EDITOR_VIEW__, expected = view.state.doc.toString().indexOf(text);
      if (expected < 0) throw new Error(`Missing source text: ${text}`);
      const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.data.indexOf(text);
        if (start < 0) continue;
        node.parentElement.closest(".cm-line").scrollIntoView({ block: "center" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const range = document.createRange();
        range.setStart(node, start + index);
        range.setEnd(node, start + index + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.25, y: (rect.top + rect.bottom) / 2,
          expected: expected + index };
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

  const margins = await page.locator(".cm-line").evaluateAll((lines) => lines.map((line) => ({
    text: line.textContent, top: parseFloat(getComputedStyle(line).marginTop),
    bottom: parseFloat(getComputedStyle(line).marginBottom),
  })).filter((line) => line.top || line.bottom));
  if (margins.length) throw new Error(`Editor lines have vertical margins: ${JSON.stringify(margins)}`);
  await page.locator("#mode-toggle").click();
  await clickText("Deep target paragraph.", 8);
  const sourceFont = await page.locator(".cm-scroller").evaluate((scroller) =>
    getComputedStyle(scroller).fontFamily);
  if (!sourceFont.includes("monospace")) throw new Error(`Source font changed: ${sourceFont}`);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Browser smoke: preview, visual font, exact cursor clicks and line spacing passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  rmSync(binary, { force: true });
}
