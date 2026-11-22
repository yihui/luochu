import {parse, renderHTML} from '@djot/djot'
import {EditorState, StateEffect, StateField} from '@codemirror/state'
import {EditorView, keymap, Decoration} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {tokenize} from './tokens.js'
import demo from './demo.dj'

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
    items = [], hidden = [], lineSeen = new Set();

  for (const token of tokenize(text)) {
    const from = token.from, to = Math.min(token.to, text.length);
    if (to < from) continue;
    if (token.kind === 'line') {
      const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to - 1)).number;
      for (let line = first; line <= last; line++) {
        const key = `${token.cls}:${line}`;
        if (lineSeen.has(key)) continue;
        lineSeen.add(key);
        items.push({from: doc.line(line).from, to: doc.line(line).from,
          decoration: Decoration.line({class: token.cls})});
      }
    } else if (token.kind === 'hr') {
      if (to > from) items.push({from, to, decoration: Decoration.mark({class: 'dj-delim'})});
    } else if (token.kind === 'delim') {
      if (!visual) {
        if (to > from) items.push({from, to, decoration: Decoration.mark({class: 'dj-delim'})});
      } else {
        const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to - 1)).number;
        for (let number = first; number <= last; number++) {
          const line = doc.line(number), start = Math.max(from, line.from),
            end = Math.min(to, line.to);
          if (end <= start) continue;
          if (number >= firstActiveLine && number <= lastActiveLine)
            items.push({from: start, to: end,
              decoration: Decoration.mark({class: 'dj-delim dj-source'})});
          else hidden.push({from: start, to: end});
        }
      }
    } else if (token.kind === 'bullet') {
      if (to > from) items.push({from, to, decoration: Decoration.mark({class: 'dj-delim'})});
    } else if (token.kind === 'check') {
      if (to > from) items.push({from, to, decoration: Decoration.mark({
        class: visual && doc.lineAt(from).number >= firstActiveLine &&
          doc.lineAt(from).number <= lastActiveLine ? 'dj-checkbox dj-source' : 'dj-checkbox',
      })});
    } else if (to > from) {
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
function safeTableAlignmentHTML(html) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const cell of template.content.querySelectorAll('th, td')) {
    const match = /^text-align:\s*(left|center|right);?$/.exec((cell.getAttribute('style') || '').trim())
    if (match) {
      cell.classList.add(`dj-al-${match[1]}`)
      cell.removeAttribute('style')
    }
  }
  return template.innerHTML
}
function renderPreview(text) {
  preview.innerHTML = safeTableAlignmentHTML(renderHTML(parse(text, {sourcePositions: true})))
}
function schedulePreview(text) {
  if (renderPending) return
  renderPending = true
  requestAnimationFrame(() => {
    renderPending = false
    renderPreview(text)
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
        if (update.docChanged) schedulePreview(update.state.doc.toString())
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
let currentPath = null, currentHash = null, dirty = false, diskConflict = false
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
  schedulePreview(text)
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
