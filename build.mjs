import * as esbuild from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("server/static/assets", { recursive: true });
await esbuild.build({
  entryPoints: ["web/main.js"],
  bundle: true,
  format: "iife",
  outfile: "server/static/assets/app.js",
  loader: { ".dj": "text" },
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  external: ["./math.js", "./terminal.js", "./git.js"],
});
for (const name of ["app", "preview", "terminal"]) {
  await esbuild.build({
    entryPoints: [`web/${name}.css`],
    bundle: true,
    outfile: `server/static/assets/${name}.css`,
    minify: true,
  });
}
await esbuild.build({
  entryPoints: ["web/terminal.js"],
  bundle: true,
  format: "esm",
  outfile: "server/static/assets/terminal.js",
  minify: true,
});
await esbuild.build({
  entryPoints: ["web/git.js"],
  bundle: true,
  format: "esm",
  outfile: "server/static/assets/git.js",
  minify: true,
});
await esbuild.build({
  entryPoints: ["web/math.js"],
  bundle: true,
  format: "esm",
  outfile: "server/static/assets/math.js",
  minify: true,
});
await esbuild.build({
  entryPoints: ["node_modules/katex/dist/katex.min.css"],
  bundle: true,
  outfile: "server/static/assets/math.css",
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  assetNames: "fonts/[name]-[hash]",
  minify: true,
});
