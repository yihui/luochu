import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

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
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } }), errors = [];
  const imageBody = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120; canvas.height = 100;
    canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  let imageRequest, unsafeRequest = false;
  page.on("request", (request) => {
    if (request.url().includes("attacker.invalid")) unsafeRequest = true;
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
    if (message.type() === "error" && !message.text().includes("placehold.co"))
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/proxy/?token=${token}`);
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
  await page.waitForSelector("#preview .math.display .mfrac");
  if (await page.locator(".dj-math .katex-error").count())
    throw new Error("Valid math did not render correctly");
  if (await page.locator('.katex a[href^="javascript:"]').count())
    throw new Error("Untrusted math created an unsafe link");
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
    elements: document.querySelectorAll(".dj-raw-html script, #preview script, " +
      ".raw-safe[onclick], .raw-safe[style], .raw-block[onclick], .bad-link[href^='javascript:']").length,
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
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Browser smoke: visual widgets, sanitized HTML, cursor clicks and proxy paths passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  rmSync(binary, { force: true });
}
