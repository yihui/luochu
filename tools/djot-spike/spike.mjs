import { performance } from 'node:perf_hooks'
import { parse, parseEvents, renderHTML } from '@djot/djot'

const lines = []
for (let i = 1; i <= 5000; i++) {
  if (i % 500 === 1) lines.push(`## Section ${i}`)
  else if (i % 500 === 2) lines.push('')
  else if (i % 500 === 3) lines.push('A paragraph with _emphasis_, *strong*, and [a link](https://example.com).')
  else if (i % 100 === 4) lines.push('- [ ] open task')
  else if (i % 100 === 5) lines.push('- [x] completed task')
  else if (i % 250 === 6) lines.push('``` r')
  else if (i % 250 === 7) lines.push('#| label: fig-demo')
  else if (i % 250 === 8) lines.push('plot(1:10)')
  else if (i % 250 === 9) lines.push('```')
  else lines.push(`Line ${i} with plain text and H~2~O.`)
}
const text = lines.join('\n')

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function bench(name, fn) {
  const times = []
  let value
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    value = fn()
    times.push(performance.now() - start)
  }
  console.log(`${name}: median=${median(times).toFixed(3)}ms times=${times.map((v) => v.toFixed(3)).join(',')}ms`)
  return value
}

console.log(`document: lines=${text.split('\n').length} bytes=${Buffer.byteLength(text)} node=${process.version}`)
const ast = bench('parse', () => parse(text, { sourcePositions: true }))
bench('parseEvents', () => [...parseEvents(text)])
bench('renderHTML', () => renderHTML(ast))

const malformed = '_unterminated\n[link](unterminated\n``` r\n#| label: broken\nplot('
let malformedAccepted = false
try {
  parse(malformed, { sourcePositions: true })
  malformedAccepted = true
} catch {
  malformedAccepted = false
}
console.log(`malformed: parsed=${malformedAccepted}`)
