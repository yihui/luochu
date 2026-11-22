import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const binary = process.argv[2];
assert.ok(binary, "pass the path to the release binary");
const server = spawn(resolve(binary), ["-project", process.cwd()], { stdio: ["ignore", "ignore", "pipe"] });

try {
  const url = await new Promise((resolveURL, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("server did not print its URL")), 15000);
    server.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
      if (match) {
        clearTimeout(timer);
        resolveURL(match[0]);
      }
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before startup: ${code}\n${output}`));
    });
  });
  const index = await fetch(url);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /assets\/app\.js/);
  const cookie = index.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "server did not issue an authentication cookie");
  const base = new URL(url).origin;
  for (const name of ["app.js", "terminal.js", "math.js", "app.css", "terminal.css", "preview.css", "math.css"]) {
    const asset = await fetch(`${base}/assets/${name}`, { headers: { cookie } });
    assert.equal(asset.status, 200, `missing embedded asset ${name}`);
    assert.ok((await asset.text()).length > 0, `empty embedded asset ${name}`);
  }
  const capabilities = await fetch(`${base}/api/capabilities`, { headers: { cookie } });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).capabilities.terminal, true, "terminal capability is unavailable");
  console.log("Release binary serves the embedded UI and terminal capability.");
} finally {
  server.kill();
}
