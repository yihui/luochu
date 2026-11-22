import {parse, renderHTML} from '@djot/djot'
import {EditorState, StateEffect, StateField} from '@codemirror/state'
import {EditorView, keymap, Decoration} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {tokenize} from './tokens.js'
import {bullet, checkbox, image, footnote, footnoteLabel, math, table, rawHTML, renderPreviewMath,
  punctuation, rule, emptyBlock}
  from './widgets.js'
import {imageURL} from './urls.js'
import {sanitizeHTML} from './safe-html.js'
import demo from './demo.dj'

let currentPath = null, currentHash = null, dirty = false, diskConflict = false;
const setMode = StateEffect.define()
const modeField = StateField.define({
  create: () => false,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setMode)) value = effect.value
    return value
  },
})

function buildDecorations(state) {
  const doc = state.doc, text = doc.toString(), visual = state.field(modeField),
    firstActiveLine = doc.lineAt(state.selection.main.from).number,
    lastActiveLine = doc.lineAt(state.selection.main.to).number,
    items = [], hidden = [], lineSeen = new Set(), tokens = tokenize(text), widgets = [],
    invalidImages = tokens.filter((token) => token.kind === 'image' &&
      (!token.src || !imageURL(token.src, currentPath))),
    selection = state.selection.main, markupLines = tokens.filter((token) => token.kind === 'hidden_line'),
    activeMarkup = (token) => selection.from <= token.ownerTo && selection.to >= token.ownerFrom;

  if (visual) {
    for (const kind of ['table', 'raw', 'image', 'math', 'footnote', 'footnote_label']) {
      for (const token of tokens.filter((item) => item.kind === kind)) {
        let {from, to} = token;
        const block = kind === 'table' || kind === 'raw' && token.block;
        if (block) {
          if (kind === 'table' && !token.node) continue;
          from = doc.lineAt(from).from;
          to = doc.lineAt(to).to;
        } else if (doc.lineAt(from).number !== doc.lineAt(to - 1).number) continue;
        if (kind === 'image' && (!token.src || !imageURL(token.src, currentPath))) continue;
        if (selection.from <= to && selection.to >= from) continue;
        if (widgets.some((item) => from < item.to && to > item.from)) continue;
        const widget = kind === 'table' ? table(token, text.slice(from, to), currentPath)
          : kind === 'raw' ? rawHTML(token, currentPath)
          : kind === 'image' ? image(token, currentPath)
          : kind === 'math' ? math(token)
          : kind === 'footnote' ? footnote(token) : footnoteLabel(token);
        widgets.push({from, to});
        items.push({from, to, decoration: Decoration.replace({widget, block})});
      }
    }
    for (const token of tokens.filter((item) => item.kind === 'empty_block')) {
      if (activeMarkup(token) ||
        widgets.some((item) => token.ownerFrom < item.to && token.ownerTo > item.from)) continue;
      items.push({from: token.from, to: token.to,
        decoration: Decoration.widget({widget: emptyBlock(token), block: true, side: -1})});
    }
    for (const line of markupLines) {
      if (line.to <= line.from || activeMarkup(line) ||
        widgets.some((item) => line.from < item.to && line.to > item.from)) continue;
      widgets.push({from: line.from, to: line.to});
      items.push({from: line.from, to: line.to, decoration: Decoration.replace({block: true})});
    }
  }
  for (const token of tokens) {
    const from = token.from, to = Math.min(token.to, text.length);
    if (to < from) continue;
    if (token.kind === 'line') {
      const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to - 1)).number;
      for (let line = first; line <= last; line++) {
        const key = `${token.cls}:${line}`;
        if (widgets.some((item) => doc.line(line).from >= item.from &&
          doc.line(line).to <= item.to)) continue;
        if (lineSeen.has(key)) continue;
        lineSeen.add(key);
        items.push({from: doc.line(line).from, to: doc.line(line).from,
          decoration: Decoration.line({class: token.cls})});
      }
    } else if (widgets.some((item) => from >= item.from && to <= item.to)) {
      continue;
    } else if (token.kind === 'hr') {
      if (to > from) items.push({from, to, decoration: visual &&
        !(selection.from <= to && selection.to >= from)
        ? Decoration.replace({widget: rule(from)}) : Decoration.mark({class: 'dj-delim dj-source'})});
    } else if (token.kind === 'punctuation') {
      if (to > from) items.push({from, to, decoration: visual &&
        !(selection.from <= to && selection.to >= from)
        ? Decoration.replace({widget: punctuation(token)}) : Decoration.mark({class: 'dj-source'})});
    } else if (token.kind === 'delim') {
      if (!visual || invalidImages.some((item) => from >= item.from && to <= item.to)) {
        if (to > from) items.push({from, to, decoration: Decoration.mark({
          class: visual ? 'dj-delim dj-source' : 'dj-delim',
        })});
      } else {
        const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to - 1)).number;
        for (let number = first; number <= last; number++) {
          const line = doc.line(number), start = Math.max(from, line.from),
            end = Math.min(to, line.to);
          if (end <= start) continue;
          if (number >= firstActiveLine && number <= lastActiveLine ||
            markupLines.some((line) => from >= line.from && to <= line.to && activeMarkup(line)))
            items.push({from: start, to: end,
              decoration: Decoration.mark({class: 'dj-delim dj-source'})});
          else hidden.push({from: start, to: end});
        }
      }
    } else if (token.kind === 'bullet') {
      if (to > from) items.push({from, to, decoration: visual &&
        (doc.lineAt(from).number < firstActiveLine || doc.lineAt(from).number > lastActiveLine)
        ? Decoration.replace({widget: bullet}) : Decoration.mark({class: 'dj-delim dj-source'})});
    } else if (token.kind === 'check') {
      if (to > from) items.push({from, to, decoration: visual
        ? Decoration.replace({widget: checkbox(token)}) : Decoration.mark({class: 'dj-checkbox'})});
    } else if (token.kind === 'mark' && to > from) {
      items.push({from, to, decoration: Decoration.mark({class: token.cls})});
    }
  }
  hidden.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of hidden) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({...range});
  }
  for (const range of merged)
    items.push({...range, decoration: Decoration.replace({})});
  return Decoration.set(items.map((item) => item.decoration.range(item.from, item.to)), true);
}

const decoField = StateField.define({
  create: buildDecorations,
  update: (value, tr) => tr.docChanged || tr.selection || tr.effects.length
    ? buildDecorations(tr.state) : value,
  provide: (field) => EditorView.decorations.from(field),
})

const preview = document.querySelector('#preview')
const previewPane = document.querySelector('#preview-pane')
let renderPending = false
function renderPreview(text) {
  preview.replaceChildren(sanitizeHTML(renderHTML(parse(text, {sourcePositions: true})), currentPath))
  renderPreviewMath(preview)
}
function schedulePreview() {
  if (renderPending) return
  renderPending = true
  requestAnimationFrame(() => {
    renderPending = false
    renderPreview(view.state.doc.toString())
  })
}

const view = new EditorView({
  parent: document.querySelector('#editor'),
  state: EditorState.create({
    doc: demo,
    extensions: [
      history(), keymap.of([...defaultKeymap, ...historyKeymap]),
      modeField, decoField, EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        view.dom.classList.toggle('visual', view.state.field(modeField))
        if (update.docChanged) schedulePreview()
        if (update.docChanged && currentPath && !diskConflict) {
          dirty = true
          saveButton.textContent = 'Save*'
        }
      }),
    ],
  }),
})
renderPreview(demo)

const toggle = document.querySelector('#mode-toggle')
const applyMode = (visual) => {
  view.dom.classList.toggle('visual', visual)
  toggle.textContent = visual ? 'Visual' : 'Source'
  view.dispatch({effects: setMode.of(visual)})
}
toggle.onclick = () => applyMode(!view.state.field(modeField))
if (location.hash === '#visual') applyMode(true)

let syncFromPreview = false
let sourceScrollTimer = null
view.scrollDOM.addEventListener('scroll', () => {
  if (syncFromPreview) return
  clearTimeout(sourceScrollTimer)
  sourceScrollTimer = setTimeout(() => {
    if (syncFromPreview) return
    const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from
    const line = view.state.doc.lineAt(top).number
    let target = null
    for (const element of preview.querySelectorAll('[data-startpos]')) {
      if (Number(element.dataset.startpos.split(':')[0]) <= line) target = element
      else break
    }
    if (target) previewPane.scrollTop = target.offsetTop - previewPane.offsetTop
  }, 80)
})

preview.addEventListener('click', (event) => {
  const element = event.target.closest('[data-startpos]')
  if (!element) return
  syncFromPreview = true
  const offset = Number(element.dataset.startpos.split(':')[2])
  view.dispatch({selection: {anchor: offset}, scrollIntoView: true})
  view.focus()
  setTimeout(() => { syncFromPreview = false }, 100)
})

window.__LUOCHU_EDITOR_VIEW__ = view

const fileTree = document.querySelector('#file-tree')
const saveButton = document.querySelector('#save-file')
const apiUrl = (path) => new URL(path, document.baseURI).toString()
async function loadTree(directory = '') {
  const response = await fetch(apiUrl(`api/files?path=${encodeURIComponent(directory)}`), {credentials: 'same-origin'})
  if (!response.ok) { fileTree.textContent = 'Project unavailable'; return }
  const entries = await response.json()
  fileTree.replaceChildren()
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = entry.type === 'directory' ? `${entry.name}/` : entry.name
    button.onclick = async () => entry.type === 'directory'
      ? loadTree(entry.path) : openFile(entry.path)
    fileTree.append(button)
  }
}
async function openFile(path) {
  if (dirty && !window.confirm('Discard unsaved changes and open another file?')) return
  const response = await fetch(apiUrl(`api/file?path=${encodeURIComponent(path)}`), {credentials: 'same-origin'})
  if (!response.ok) return
  const text = await response.text()
  currentPath = path
  currentHash = response.headers.get('X-Luochu-Hash')
  dirty = false
  diskConflict = false
  saveButton.disabled = false
  view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}})
  schedulePreview()
  document.title = `Luochu - ${path}`
}
saveButton.onclick = async () => {
  if (!currentPath) return
  const response = await fetch(apiUrl(`api/file?path=${encodeURIComponent(currentPath)}`), {
    method: 'PUT', credentials: 'same-origin',
    headers: {'Content-Type': 'text/plain', 'If-Match': currentHash},
    body: view.state.doc.toString(),
  })
  if (response.status === 409) { diskConflict = true; saveButton.textContent = 'Conflict'; return }
  if (!response.ok) return
  currentHash = response.headers.get('X-Luochu-Hash')
  dirty = false
  diskConflict = false
  saveButton.textContent = 'Save'
}
loadTree()
