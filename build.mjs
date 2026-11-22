import * as esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('server/static/assets', { recursive: true })
await esbuild.build({
  entryPoints: ['web/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'server/static/assets/app.js',
  loader: { '.dj': 'text' },
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
await esbuild.build({
  entryPoints: ['web/app.css'],
  bundle: true,
  outfile: 'server/static/assets/app.css',
})
