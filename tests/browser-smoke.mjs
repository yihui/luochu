import { chromium } from "playwright";
import * as esbuild from "esbuild";
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
  const noMathBundle = await esbuild.build({
    entryPoints: ["web/main.js"], bundle: true, format: "iife", write: false,
    loader: { ".dj": "text" }, external: ["./math.js"], minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "no-math-demo", setup(build) {
      build.onLoad({ filter: /demo\.dj$/ }, () => ({ contents: "A document without math.", loader: "text" }));
    } }],
  });
  const noMathPage = await browser.newPage(), mathRequests = [];
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
  await noMathPage.evaluate(() => {
    const view = window.__LUOCHU_EDITOR_VIEW__;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "First edit." } });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Math $`x^2`." } });
  });
  await noMathPage.frameLocator("#preview-pane").locator("#preview .math .katex")
    .waitFor({ timeout: 5000 });
  if (mathRequests.length !== 2) throw new Error("KaTeX assets did not load when math appeared");
  await noMathPage.close();

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
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Browser smoke: visual widgets, sanitized HTML, cursor clicks and proxy paths passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  rmSync(binary, { force: true });
}
