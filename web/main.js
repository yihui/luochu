import {parse, renderHTML} from '@djot/djot'
import {EditorState, StateEffect, StateField} from '@codemirror/state'
import {EditorView, keymap, Decoration, lineNumbers} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {tokenize} from './tokens.js'
import {bullet, checkbox, image, footnote, footnoteLabel, math, table, rawHTML, renderPreviewMath,
  punctuation, rule, emptyBlock}
  from './widgets.js'
import {imageURL} from './urls.js'
import {sanitizeHTML} from './safe-html.js'
import {loadStylesheet} from './assets.js'
import demo from './demo.dj'

let currentPath = null, activeTab = null, openSequence = 0;
const tabs = [];
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

const previewPane = document.querySelector('#preview-pane')
let preview = null, renderPending = false
function renderPreview(text) {
  if (!preview || activeTab && !activeTab.djot) return
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

function editorState(doc, djot, separator = '\n') {
  return EditorState.create({
    doc,
    extensions: [
      history(), keymap.of([...defaultKeymap, ...historyKeymap]),
      modeField, djot ? decoField : [], separator ? EditorState.lineSeparator.of(separator) : [],
      EditorView.lineWrapping, lineNumbers(),
      EditorView.updateListener.of((update) => {
        view.dom.classList.toggle('visual', view.state.field(modeField))
        if (update.docChanged && (!activeTab || activeTab.djot)) schedulePreview()
        if (update.docChanged && activeTab && !activeTab.kind) {
          activeTab.dirty = true
          updateFileUI()
        }
      }),
    ],
  })
}
const view = new EditorView({
  parent: document.querySelector('#editor'),
  state: editorState(demo, true),
})
let demoState = view.state;
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
    if (syncFromPreview || !preview || activeTab && !activeTab.djot) return
    const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from
    const line = view.state.doc.lineAt(top).number
    let target = null
    for (const element of preview.querySelectorAll('[data-startpos]')) {
      if (Number(element.dataset.startpos.split(':')[0]) <= line) target = element
      else break
    }
    if (target) previewPane.contentWindow.scrollTo(0, target.offsetTop)
  }, 80)
})

function initPreview() {
  const next = previewPane.contentDocument?.querySelector('#preview')
  if (!next || next === preview) return
  preview = next
  preview.addEventListener('click', (event) => {
    if (event.target.closest('a')) event.preventDefault()
    const element = event.target.closest('[data-startpos]')
    if (!element || !/^\d+:\d+:\d+$/.test(element.dataset.startpos)) return
    const offset = Number(element.dataset.startpos.split(':')[2])
    if (!Number.isSafeInteger(offset) || offset > view.state.doc.length) return
    syncFromPreview = true
    view.dispatch({selection: {anchor: offset}, scrollIntoView: true})
    view.focus()
    setTimeout(() => { syncFromPreview = false }, 100)
  })
  renderPreview(view.state.doc.toString())
}
previewPane.addEventListener('load', initPreview)
initPreview()

window.__LUOCHU_EDITOR_VIEW__ = view

const fileTree = document.querySelector('#file-tree')
const saveButton = document.querySelector('#save-file')
const fileTabs = document.querySelector('#file-tabs')
const fileStatus = document.querySelector('#file-status')
const apiUrl = (path) => new URL(path, document.baseURI).toString()
let gitDirectory = '', gitUI = null, gitAssets = null;
function selectGitDirectory(directory) {
  gitDirectory = directory;
  gitUI?.setDirectory(directory);
}
function updateFileUI() {
  saveButton.disabled = !activeTab || !!activeTab.kind || activeTab.saving
  saveButton.textContent = activeTab?.conflict ? 'Conflict' : activeTab?.dirty ? 'Save*' : 'Save'
  fileTabs.replaceChildren()
  for (const tab of tabs) {
    const item = document.createElement('span'), select = document.createElement('button'),
      close = document.createElement('button')
    item.className = `file-tab${tab === activeTab ? ' active' : ''}`
    select.type = close.type = 'button'
    select.textContent = tab.kind === 'git-diff' ? 'Git diff'
      : tab.kind === 'git-history' ? 'Git history'
      : `${tab.path.split('/').pop()}${tab.dirty ? ' *' : ''}`
    select.title = tab.path || select.textContent
    select.setAttribute('aria-pressed', String(tab === activeTab))
    select.onclick = () => { openSequence++; activateTab(tab) }
    close.textContent = '×'
    close.setAttribute('aria-label', `Close ${tab.path || select.textContent}`)
    close.onclick = () => closeTab(tab)
    item.append(select, close)
    fileTabs.append(item)
  }
}
function activateTab(tab) {
  const previous = activeTab
  if (activeTab && !activeTab.kind) {
    activeTab.state = view.state
    activeTab.scrollTop = view.scrollDOM.scrollTop
  } else if (!activeTab) demoState = view.state
  activeTab = tab
  const gitTab = tab?.kind === 'git-diff' || tab?.kind === 'git-history'
  currentPath = gitTab ? null : tab?.path || null
  if (!gitTab && (tab || !previous?.kind))
    selectGitDirectory(tab ? tab.path.split('/').slice(0, -1).join('/') : '')
  const gitDiff = document.querySelector('#git-diff'), gitHistory = document.querySelector('#git-history')
  document.querySelector('main').classList.toggle('show-git-content', !!gitTab)
  if (gitTab) {
    if (tab.kind !== 'git-diff') gitUI?.closeDiff()
    gitHistory.hidden = tab.kind !== 'git-history'
    document.querySelector('main').classList.toggle('plain-file', true)
    toggle.hidden = true
    if (tab.kind === 'git-diff') gitUI?.showDiff(tab.selected)
    else gitUI?.showHistory()
  } else {
    gitUI?.closeDiff()
    gitDiff.hidden = true
    gitHistory.hidden = true
    view.setState(tab ? tab.state : demoState)
    view.scrollDOM.scrollTop = tab?.scrollTop || 0
    const djot = !tab || tab.djot, visual = djot && view.state.field(modeField)
    view.dom.classList.toggle('visual', visual)
    toggle.hidden = !djot
    toggle.textContent = visual ? 'Visual' : 'Source'
    previewPane.hidden = !djot
    document.querySelector('main').classList.toggle('plain-file', !djot)
    if (djot) schedulePreview()
  }
  if (!gitTab) document.title = tab ? `Luochu - ${tab.path}` : 'Luochu'
  else document.title = `Luochu - ${tab.kind === 'git-diff' ? 'Git diff' : 'Git history'}`
  fileStatus.textContent = ''
  updateFileUI()
}
function closeTab(tab) {
  openSequence++
  if (!tab.kind && tab.saving) { fileStatus.textContent = `Wait for ${tab.path} to finish saving.`; return }
  if (!tab.kind && tab.dirty && !window.confirm(`Discard unsaved changes in ${tab.path}?`)) return
  const index = tabs.indexOf(tab)
  tabs.splice(index, 1)
  if (tab === activeTab) activateTab(tabs[Math.min(index, tabs.length - 1)] || null)
  else updateFileUI()
}
function openGitTab(kind, selected = null) {
  const existing = tabs.find((tab) => tab.kind === kind)
  const tab = existing || {kind, path: kind === 'git-diff' ? 'Git diff' : 'Git history', selected}
  if (!existing) tabs.push(tab)
  tab.selected = selected
  openSequence++
  activateTab(tab)
}
window.addEventListener('beforeunload', (event) => {
  if (tabs.some((tab) => tab.dirty || tab.saving)) event.preventDefault()
})
async function loadTree(container, directory = '') {
  container.textContent = 'Loading...';
  let entries;
  try {
    const response = await fetch(apiUrl(`api/files?path=${encodeURIComponent(directory)}`), {credentials: 'same-origin'});
    if (!response.ok) throw new Error(`Directory request failed: ${response.status}`);
    entries = await response.json();
  } catch (error) {
    container.textContent = directory ? 'Directory unavailable; close and reopen to retry' : 'Project unavailable';
    console.error(error);
    return false;
  }
  container.replaceChildren();
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.type === 'directory') {
      const folder = document.createElement('details'), label = document.createElement('summary'),
        children = document.createElement('div');
      label.textContent = entry.name;
      children.className = 'file-tree-children';
      folder.append(label, children);
      label.addEventListener('click', () => selectGitDirectory(entry.path));
      let loaded = false, loading = false;
      folder.addEventListener('toggle', async () => {
        if (!folder.open || loaded || loading) return;
        loading = true;
        loaded = await loadTree(children, entry.path);
        loading = false;
      });
      container.append(folder);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.name;
      button.onclick = () => openFile(entry.path);
      container.append(button);
    }
  }
  if (!container.childNodes.length) container.textContent = '(empty)';
  return true;
}
function jumpToLine(line) {
  if (!line) return
  const number = Math.min(line, view.state.doc.lines)
  view.dispatch({selection: {anchor: view.state.doc.line(number).from}, scrollIntoView: true})
  view.focus()
}
async function openFile(path, line = null) {
  const sequence = ++openSequence, existing = tabs.find((tab) => !tab.kind && tab.path === path)
  if (existing) { activateTab(existing); jumpToLine(line); return }
  fileStatus.textContent = ''
  let response, text
  try {
    response = await fetch(apiUrl(`api/file?path=${encodeURIComponent(path)}&text=1`), {credentials: 'same-origin'})
    if (response.status === 415) {
      const reason = (await response.text()).trim()
      if (sequence === openSequence) fileStatus.textContent = `Cannot open ${path}: ${reason}.`
      return
    }
    if (!response.ok) throw new Error(`File request failed: ${response.status}`)
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await response.arrayBuffer())
  } catch (error) {
    if (sequence === openSequence) fileStatus.textContent = `Could not open ${path}: ${error.message}`
    return
  }
  if (sequence !== openSequence) return
  const djot = /\.dj$/i.test(path),
    crlf = text.includes('\r\n') && !/(^|[^\r])\n|\r(?!\n)/.test(text),
    tab = {path, hash: response.headers.get('X-Luochu-Hash'), djot,
      crlf, dirty: false, conflict: false, saving: false, scrollTop: 0}
  const previousPath = currentPath
  currentPath = path
  tab.state = editorState(text, djot, crlf ? null : '\n')
  currentPath = previousPath
  tabs.push(tab)
  activateTab(tab)
  jumpToLine(line)
}
function tabText(tab, state) {
  const text = state.sliceDoc()
  return tab.crlf ? text.replace(/\n/g, '\r\n') : text
}
saveButton.onclick = async () => {
  const tab = activeTab
  if (!tab || tab.kind || tab.saving) return
  const text = tabText(tab, view.state)
  tab.saving = true
  updateFileUI()
  try {
    const response = await fetch(apiUrl(`api/file?path=${encodeURIComponent(tab.path)}`), {
      method: 'PUT', credentials: 'same-origin',
      headers: {'Content-Type': 'text/plain', 'If-Match': tab.hash},
      body: text,
    })
    if (response.status === 409) {
      tab.conflict = true
      fileStatus.textContent = `Could not save ${tab.path}: the file changed on disk.`
    } else if (!response.ok) throw new Error(`File request failed: ${response.status}`)
    else {
      tab.hash = response.headers.get('X-Luochu-Hash')
      tab.dirty = tabText(tab, tab === activeTab ? view.state : tab.state) !== text
      tab.conflict = false
      fileStatus.textContent = ''
      gitUI?.refresh()
    }
  } catch (error) {
    fileStatus.textContent = `Could not save ${tab.path}: ${error.message}`
  } finally {
    tab.saving = false
    updateFileUI()
  }
}
loadTree(fileTree)

const terminalControls = document.querySelector('#terminal-controls'),
  terminalToggle = document.querySelector('#terminal-toggle'),
  terminalPaste = document.querySelector('#terminal-paste'),
  terminalPane = document.querySelector('#terminal-pane'),
  terminalStatus = document.querySelector('#terminal-status');
let terminalSession = null, terminalAssets = null;
fetch(apiUrl('api/capabilities'), {credentials: 'same-origin'}).then((response) => {
  if (!response.ok) throw new Error(`Capability request failed: ${response.status}`);
  return response.json();
}).then(({capabilities}) => {
  if (capabilities.terminal) terminalControls.hidden = false;
  if (capabilities.git) {
    document.querySelector('#git-toggle').hidden = false;
    document.querySelector('#project-root').hidden = false;
  }
}).catch((error) => console.error('Could not load capabilities:', error));

const gitToggle = document.querySelector('#git-toggle'), filesToggle = document.querySelector('#files-toggle'),
  gitPane = document.querySelector('#git-pane'), projectRoot = document.querySelector('#project-root');
projectRoot.onclick = () => selectGitDirectory('');
filesToggle.onclick = () => {
  fileTree.hidden = false;
  projectRoot.hidden = gitToggle.hidden;
  gitPane.hidden = true;
  filesToggle.setAttribute('aria-pressed', 'true');
  gitToggle.setAttribute('aria-pressed', 'false');
};
gitToggle.onclick = async () => {
  fileTree.hidden = true;
  projectRoot.hidden = true;
  gitPane.hidden = false;
  filesToggle.setAttribute('aria-pressed', 'false');
  gitToggle.setAttribute('aria-pressed', 'true');
  if (gitUI) { gitUI.refresh(); return; }
  gitPane.textContent = 'Loading Git…';
  try {
    if (!gitAssets) gitAssets = import('./git.js').catch((error) => { gitAssets = null; throw error; });
    const module = await gitAssets;
    if (!gitUI) gitUI = module.createGitPane(gitPane, apiUrl, gitDirectory, openFile, openGitTab);
    if (!gitPane.hidden) gitUI.refresh();
  } catch (error) {
    gitPane.textContent = `Could not load Git: ${error.message}`;
  }
};

terminalToggle.onclick = async () => {
  if (!terminalPane.hidden) {
    terminalSession?.close();
    terminalSession = null;
    terminalPane.hidden = true;
    document.querySelector('main').classList.remove('terminal-open');
    terminalPaste.disabled = true;
    terminalToggle.textContent = 'Open terminal';
    return;
  }
  terminalToggle.disabled = true;
  terminalPane.hidden = false;
  document.querySelector('main').classList.add('terminal-open');
  terminalStatus.textContent = 'Loading terminal…';
  try {
    if (!terminalAssets) {
      const {link, ready} = loadStylesheet(document, apiUrl('assets/terminal.css'), 'terminal');
      terminalAssets = Promise.all([import('./terminal.js'), ready]).then(([module]) => module)
        .catch((error) => { link.remove(); terminalAssets = null; throw error; });
    }
    const module = await terminalAssets;
    terminalSession = module.openTerminal(document.querySelector('#terminal'), terminalStatus);
    terminalPaste.disabled = false;
    terminalToggle.textContent = 'Close';
  } catch (error) {
    terminalStatus.textContent = `Could not open terminal: ${error.message}`;
    terminalToggle.textContent = 'Close';
    console.error('Could not open terminal:', error);
  } finally {
    terminalToggle.disabled = false;
  }
};
terminalPaste.onclick = () => {
  const {from, to} = view.state.selection.main, text = view.state.sliceDoc(from, to);
  if (!text) { terminalStatus.textContent = 'Select text in the editor first.'; return; }
  if (text.includes('\n') &&
    !window.confirm('Pasting multiple lines may run commands immediately. Continue?')) return;
  terminalSession?.paste(text);
};
