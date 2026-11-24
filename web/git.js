import {button, element} from './dom.js';
import {diffLines, diffLineType} from './diff.js';

export function diffLineNumbers(text) {
  const lines = diffLines(text), numbers = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    let old = null, current = null;
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (line.startsWith('diff --')) {
      inHunk = false;
    } else if (inHunk) {
      if (line.startsWith(' ') || line.startsWith('-')) old = oldLine++;
      if (line.startsWith(' ') || line.startsWith('+')) current = newLine++;
    }
    numbers.push({old, current});
  }
  return numbers;
}

export function diffLineTypes(text) {
  const state = {inHunk: false};
  return diffLines(text).map((line) => diffLineType(line, state));
}

export function splitCommitDiff(text, paths) {
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length !== paths.length) return null;
  return {
    metadata: text.slice(0, starts[0] ?? text.length),
    files: starts.map((start, index) => ({path: paths[index], text: text.slice(start, starts[index + 1])})),
  };
}

export function statusRows(changes) {
  const rows = new Map(), conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (const change of changes) {
    let row = rows.get(change.path);
    if (!row) {
      row = {path: change.path, projectPath: change.projectPath, stagedStatus: '', unstagedStatus: ''};
      rows.set(change.path, row);
    }
    if (conflicts.has(change.xy)) row.unstagedStatus = change.xy;
    else if (change.xy === '??') row.unstagedStatus = '?';
    else {
      if (change.xy[0] !== ' ') row.stagedStatus = change.xy[0];
      if (change.xy[1] !== ' ') row.unstagedStatus = change.xy[1];
    }
  }
  return [...rows.values()].map((row) => ({
    ...row, staged: !!row.stagedStatus, unstaged: !!row.unstagedStatus,
    status: row.stagedStatus && row.unstagedStatus && row.stagedStatus !== row.unstagedStatus
      ? row.stagedStatus + row.unstagedStatus : row.stagedStatus || row.unstagedStatus,
  }));
}

export function createGitPane(pane, apiUrl, initialDirectory, openFile, openGitTab) {
  let directory = initialDirectory, sequence = 0, diffSequence = 0, historySequence = 0,
    statusRequests = 0, busy = false, rows = [],
    statusKnown = false, statusFailed = false, observer = null, reviewItems = [], pendingTarget = null,
    gitInfo = null;
  const header = element('div', 'git-header'),
    branch = element('select', {attrs: {'aria-label': 'Git branch'}}),
    refreshButton = button('Refresh'), root = element('div', 'git-root'),
    message = element('div', 'git-message', {attrs: {role: 'status'}}),
    list = element('div', 'git-list'), actions = element('div', 'git-actions'),
    commitInput = element('textarea',
      {placeholder: 'Commit message', rows: 3, attrs: {'aria-label': 'Commit message'}}),
    commitButton = button('Commit'), cleanupButton = button('Cleanup merged'),
    pullButton = button('Pull'), pushButton = button('Push'),
    historyButton = button('History'),
    diff = document.querySelector('#git-diff'),
    diffContent = document.querySelector('#git-diff-content'),
    reviewByElement = new WeakMap();
  header.append(branch, refreshButton);
  const commitRow = element('div', 'git-action-row'), branchRow = element('div', 'git-action-row');
  commitRow.append(commitInput, commitButton);
  branchRow.append(pullButton, pushButton, historyButton, cleanupButton);
  actions.append(commitRow, branchRow);
  pane.replaceChildren(header, root, message, list, actions);

  const url = (params = {}) => apiUrl(`api/git?${new URLSearchParams({dir: directory, ...params})}`);
  async function responseText(response) {
    const text = await response.text();
    if (!response.ok) throw new Error(text.trim() || `Request failed: ${response.status}`);
    return text;
  }
  async function postGit(target, body) {
    return responseText(await fetch(target, {
      method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }));
  }
  function updateControls() {
    const ready = statusKnown && !statusFailed && !busy;
    commitButton.disabled = !ready || !rows.some((row) => row.staged);
    commitInput.disabled = !ready;
    branch.disabled = !ready || !branch.value;
    pullButton.disabled = pushButton.disabled = !ready || !gitInfo?.branch || !gitInfo?.remotes?.length;
    cleanupButton.disabled = !ready || !gitInfo?.branch;
    historyButton.disabled = !ready;
  }
  updateControls();
  async function gitAction(body) {
    if (busy) {
      message.textContent = 'Wait for the Git operation to finish.';
      return;
    }
    if (statusFailed) {
      message.textContent = 'Git status is stale; refresh before running Git operations.';
      return;
    }
    busy = true;
    updateControls();
    sequence++;
    const currentDirectory = directory;
    message.textContent = '';
    try {
      await postGit(url(), body);
      if (directory === currentDirectory) await refresh();
    } catch (error) {
      if (directory === currentDirectory) message.textContent = `Git operation failed: ${error.message}`;
    } finally {
      busy = false;
      updateControls();
    }
  }
  commitButton.onclick = () => gitAction({action: 'commit', message: commitInput.value});
  branch.onchange = () => {
    if (branch.value) gitAction({action: 'switch', name: branch.value});
  };
  pullButton.onclick = () => gitAction({action: 'pull'});
  pushButton.onclick = () => gitAction({action: 'push'});
  const historyList = document.querySelector('#git-history-list'),
    historyDiff = document.querySelector('#git-history-diff');
  async function showHistory() {
    const current = ++historySequence;
    historyList.textContent = 'Loading history…';
    historyDiff.textContent = '';
    try {
      const data = JSON.parse(await responseText(await fetch(url(), {credentials: 'same-origin'})));
      if (current !== historySequence) return;
      historyList.replaceChildren();
      for (const entry of data.log || []) {
        const entryButton = button(`${entry.short} ${entry.subject}`, 'git-history-entry',
          {title: `${entry.hash}\n${entry.author} · ${entry.date}`});
        entryButton.onclick = async () => {
          const selection = ++historySequence;
          historyDiff.textContent = 'Loading diff…';
          try {
            const data = JSON.parse(await responseText(await fetch(url({sha: entry.hash, format: 'files'}),
              {credentials: 'same-origin'})));
            if (selection === historySequence) renderHistoryDiff(data);
          } catch (error) {
            if (selection === historySequence) historyDiff.textContent = `Could not load commit: ${error.message}`;
          }
        };
        historyList.append(entryButton);
      }
      if (!data.log?.length) historyList.textContent = 'No commits';
    } catch (error) {
      if (current === historySequence) historyList.textContent = `Could not load history: ${error.message}`;
    }
  }
  historyButton.onclick = () => openGitTab('git-history');
  const cleanupDialog = element('dialog', 'git-cleanup'),
    cleanupBase = element('select', {attrs: {'aria-label': 'Cleanup base branch'}}),
    cleanupLocal = element('div'), cleanupWorktrees = element('div'), cleanupNote = element('div'),
    cleanupActions = element('div'), cleanupCancel = button('Cancel'),
    cleanupRemove = button('Delete selected');
  cleanupActions.append(cleanupCancel, cleanupRemove);
  cleanupDialog.append(cleanupBase, cleanupNote, cleanupLocal, cleanupWorktrees, cleanupActions);
  pane.append(cleanupDialog);
  cleanupCancel.onclick = () => cleanupDialog.close();

  function cleanupSection(title, container) {
    container.replaceChildren();
    const heading = element('strong', null, title);
    container.append(heading);
  }
  async function loadCleanupPreview() {
    cleanupRemove.disabled = busy;
    cleanupNote.textContent = 'Scanning branches…';
    try {
      const data = JSON.parse(await postGit(url(), {action: 'cleanup-preview', base: cleanupBase.value}));
      cleanupNote.textContent = data.fetchNote
        ? `Fetch/prune warning: ${data.fetchNote}`
        : 'Candidates use merged branches, pruned remotes, and GitHub merged/closed PR branches.';

      cleanupSection('Local branches', cleanupLocal);
      for (const candidate of [...(data.local || [])].sort((a, b) => a.name.localeCompare(b.name))) {
        const label = element('label'),
          input = element('input', {type: 'checkbox', checked: true,
            attrs: {'data-name': candidate.name, 'data-cleanup': 'local'}}),
          text = element('span', null, ` ${candidate.name} — ${candidate.reason}`);
        label.append(input, text);
        cleanupLocal.append(label);
      }
      if (!data.local?.length) cleanupLocal.append(document.createTextNode(' No candidates'));

      cleanupSection('Associated worktrees', cleanupWorktrees);
      for (const wt of [...(data.worktrees || [])].sort((a, b) => a.path.localeCompare(b.path))) {
        const label = element('label'),
          input = element('input', {type: 'checkbox', checked: false, attrs: {'data-path': wt.path}}),
          text = element('span', null, ` ${wt.path} — ${wt.branch}`);
        label.append(input, text);
        cleanupWorktrees.append(label);
      }
      if (!data.worktrees?.length) cleanupWorktrees.append(document.createTextNode(' No associated worktrees'));
    } catch (error) {
      cleanupNote.textContent = `Could not scan branches: ${error.message}`;
    }
  }
  function setBranchOptions(select, names) {
    select.replaceChildren();
    for (const name of names) {
      const option = element('option', null, name, {value: name});
      select.append(option);
    }
  }
  function hasBranchOption(select, name) {
    return [...select.options].some((option) => option.value === name);
  }
  cleanupButton.onclick = async () => {
    setBranchOptions(cleanupBase, gitInfo?.branches || []);
    const preferred = gitInfo?.branches?.includes('main') ? 'main'
      : gitInfo?.branches?.includes('master') ? 'master' : gitInfo?.branch;
    if (hasBranchOption(cleanupBase, preferred))
      cleanupBase.value = preferred;
    cleanupDialog.showModal();
    await loadCleanupPreview();
  };
  cleanupBase.onchange = loadCleanupPreview;
  cleanupRemove.onclick = async () => {
    const local = [...cleanupLocal.querySelectorAll('[data-cleanup="local"]:checked')]
      .map((input) => input.dataset.name);
    const worktrees = [...cleanupWorktrees.querySelectorAll('input:checked')]
      .map((input) => input.dataset.path).filter(Boolean);
    if (!local.length && !worktrees.length) return;
    if (!window.confirm(`Delete ${local.length} local branch(es) and remove ${worktrees.length} worktree(s)?`)) return;
    busy = true;
    updateControls();
    cleanupRemove.disabled = true;
    try {
      await postGit(url(), {action: 'cleanup', base: cleanupBase.value, local, worktrees});
      cleanupDialog.close();
      await refresh();
    } catch (error) {
      cleanupNote.textContent = `Cleanup failed: ${error.message}`;
    } finally {
      busy = false;
      updateControls();
      cleanupRemove.disabled = false;
    }
  };
  function closeDiff() {
    diffSequence++;
    observer?.disconnect();
    observer = null;
    for (const item of reviewItems) item.controller?.abort();
    reviewItems = [];
    pendingTarget = null;
    diff.hidden = true;
  }
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
    diffContent.addEventListener(event, () => { pendingTarget = null; });
  function navigateDiff(selected) {
    const item = selected && reviewItems.find(({row}) => row.path === selected.path);
    if (!item) return;
    item.section.open = true;
    pendingTarget = item;
    loadDiff(item);
    item.section.scrollIntoView({block: 'start'});
  }
  function createDiffSection(path) {
    const section = element('details', 'git-diff-file', {open: true}), summary = element('summary'),
      heading = element('h3', null, path), counts = element('span', 'git-diff-counts'),
      content = element('div');
    summary.append(heading, counts);
    section.append(summary, content);
    return {section, heading, counts, content};
  }
  function renderHistoryDiff({text, paths}) {
    const parsed = splitCommitDiff(text, paths), fragment = document.createDocumentFragment(),
      metadata = element('pre', 'git-history-metadata');
    if (!parsed) {
      metadata.textContent = `Could not split commit diff by file; showing raw output.\n\n${text}`;
      historyDiff.replaceChildren(metadata);
      return;
    }
    metadata.textContent = parsed.metadata;
    fragment.append(metadata);
    for (const file of parsed.files) {
      const item = {...createDiffSection(file.path), row: {path: file.path}};
      renderDiff(item, file.text, false);
      fragment.append(item.section);
    }
    historyDiff.replaceChildren(fragment);
    historyDiff.scrollTop = 0;
  }
  function renderDiff(item, text, canOpen = true) {
    const scroller = element('div', 'git-diff-scroll'), source = element('pre', 'git-diff-text'),
      numbers = diffLineNumbers(text), types = diffLineTypes(text), lines = diffLines(text);
    const added = types.filter((type) => type === 'added').length,
      removed = types.filter((type) => type === 'removed').length;
    item.counts.replaceChildren();
    for (const [type, count, sign] of [['added', added, '+'], ['removed', removed, '-']]) {
      const span = element('span', `git-count-${type}`, `${sign}${count}`);
      item.counts.append(span);
    }
    const fragment = document.createDocumentFragment();
    numbers.forEach(({old, current}, index) => {
      const row = element('span', 'git-diff-row'),
        oldGutter = element('span', 'git-gutter git-old-gutter'),
        newGutter = element('span', 'git-gutter git-new-gutter'),
        line = element('span', `git-diff-line${types[index] ? ` git-diff-${types[index]}` : ''}`,
          lines[index] + (index < lines.length - 1 || text.endsWith('\n') ? '\n' : ''));
      if (old !== null) oldGutter.dataset.line = old;
      if (current && !canOpen) newGutter.dataset.line = current;
      else if (current) {
        const jump = button(undefined, null,
          {attrs: {'data-line': current, 'aria-label': `Open ${item.row.path} at line ${current}`}});
        if (!item.row.projectPath) {
          jump.disabled = true;
          jump.title = 'File is outside the project root';
        }
        newGutter.append(jump);
      }
      row.append(oldGutter, newGutter, line);
      fragment.append(row);
    });
    source.append(fragment);
    source.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button && !button.disabled) openFile(item.row.projectPath, Number(button.dataset.line));
    });
    scroller.append(source);
    item.content.replaceChildren(scroller);
  }
  function loadDiff(item) {
    if (!observer || document.hidden || !item.section.isConnected ||
      item.loading || !item.section.open) return;
    const wasLoaded = item.loaded;
    item.loading = true;
    item.stale = false;
    if (!wasLoaded) item.content.textContent = 'Loading diff…';
    const current = diffSequence, version = ++item.version;
    item.controller = new AbortController();
    fetch(url({file: item.row.path, group: item.row.group}), {
      credentials: 'same-origin', signal: item.controller.signal,
    }).then(responseText).then((text) => {
      if (current === diffSequence && version === item.version) {
        if (!item.loaded || text !== item.text) {
          if (text) renderDiff(item, text);
          else {
            item.counts.replaceChildren();
            item.content.textContent = '(No textual diff)';
          }
        }
        item.text = text;
        item.loaded = true;
      }
    }).catch((error) => {
      if (current === diffSequence && version === item.version) {
        item.loaded = false;
        item.counts.replaceChildren();
        item.content.textContent = `Could not load diff: ${error.message}`;
      }
    }).finally(() => {
      if (current !== diffSequence || version !== item.version) return;
      item.loading = false;
      item.controller = null;
      if (wasLoaded || !pendingTarget) return;
      if (item === pendingTarget ||
        item.section.compareDocumentPosition(pendingTarget.section) & Node.DOCUMENT_POSITION_FOLLOWING)
        requestAnimationFrame(() => {
          if (current === diffSequence && pendingTarget)
            pendingTarget.section.scrollIntoView({block: 'start'});
        });
    });
  }
  function createReviewItem(row) {
    const item = {...createDiffSection(row.path), row, loading: false, loaded: false, stale: true, visible: false,
        text: null, version: 0, controller: null};
    const {section, content} = item;
    content.textContent = 'Waiting to load…';
    section.addEventListener('toggle', () => {
      if (!section.open || !item.stale || item.loading) return;
      const bounds = section.getBoundingClientRect(), viewport = diffContent.getBoundingClientRect();
      if (bounds.bottom >= viewport.top - 200 && bounds.top <= viewport.bottom + 200) loadDiff(item);
    });
    reviewByElement.set(section, item);
    return item;
  }
  function invalidateDiff(item, reset) {
    item.version++;
    item.controller?.abort();
    item.loading = false;
    item.stale = true;
    if (reset) {
      item.loaded = false;
      item.text = null;
      item.counts.replaceChildren();
      item.content.textContent = 'Waiting to load…';
    }
    if (item.visible) loadDiff(item);
  }
  function refreshDiffs() {
    for (const item of reviewItems) {
      if (item.loading) continue;
      item.stale = true;
      if (item.visible) loadDiff(item);
    }
  }
  function updateReview(changedPath = null) {
    const existing = new Map(reviewItems.map((item) => [item.row.path, item])), next = [];
    if (!reviewItems.length) diffContent.replaceChildren();
    let cursor = diffContent.firstElementChild;
    for (const file of rows) {
      const row = {...file, group: file.unstaged ? 'unstaged' : 'staged'};
      let item = existing.get(row.path);
      if (item) {
        existing.delete(row.path);
        const reset = item.row.group !== row.group || item.row.projectPath !== row.projectPath,
          changed = reset ||
          item.row.stagedStatus !== row.stagedStatus || item.row.unstagedStatus !== row.unstagedStatus ||
          changedPath === row.path;
        item.row = row;
        if (changed) invalidateDiff(item, reset);
      } else {
        item = createReviewItem(row);
        observer.observe(item.section);
      }
      if (item.heading.textContent !== row.path) item.heading.textContent = row.path;
      if (item.section !== cursor) diffContent.insertBefore(item.section, cursor);
      cursor = item.section.nextElementSibling;
      next.push(item);
    }
    for (const item of existing.values()) {
      item.version++;
      item.controller?.abort();
      observer.unobserve(item.section);
      item.section.remove();
      if (pendingTarget === item) pendingTarget = null;
    }
    reviewItems = next;
    if (!reviewItems.length) diffContent.textContent = 'No changes';
  }
  function showDiff(selected) {
    if (!diff.hidden) { navigateDiff(selected); return; }
    const current = ++diffSequence;
    diffContent.replaceChildren();
    diff.hidden = false;
    observer = new IntersectionObserver((entries) => {
      if (current !== diffSequence) return;
      for (const entry of entries) {
        const item = reviewByElement.get(entry.target);
        if (!item) continue;
        item.visible = entry.isIntersecting;
        if (item.visible && item.stale) loadDiff(item);
      }
    }, {root: diffContent, rootMargin: '200px 0px'});
    updateReview();
    navigateDiff(selected);
  }
  function setCheckbox(row, checkbox) {
    checkbox.checked = row.staged && !row.unstaged;
    checkbox.indeterminate = row.staged && row.unstaged;
  }
  async function change(row, checkbox) {
    if (statusFailed) {
      setCheckbox(row, checkbox);
      message.textContent = 'Git status is stale; refresh before staging or unstaging.';
      return;
    }
    if (busy) {
      setCheckbox(row, checkbox);
      message.textContent = 'Wait for the Git operation to finish.';
      return;
    }
    busy = true;
    updateControls();
    sequence++;
    checkbox.setAttribute('aria-busy', 'true');
    const target = url(), currentDirectory = directory, unstage = row.staged && !row.unstaged;
    pendingTarget = null;
    message.textContent = '';
    try {
      await postGit(target, {path: row.path, group: unstage ? 'staged' : 'unstaged',
        action: unstage ? 'unstage' : 'stage'});
      if (directory === currentDirectory && !await refresh(row.path)) setCheckbox(row, checkbox);
    } catch (error) {
      if (directory === currentDirectory) {
        setCheckbox(row, checkbox);
        message.textContent = `Git operation failed: ${error.message}`;
      }
    } finally { busy = false; updateControls(); checkbox.removeAttribute('aria-busy'); }
  }
  const pageSize = 40, pages = [], visiblePages = new Set(), pageIndex = new WeakMap(),
    rowState = new WeakMap();
  function createRow(row) {
    const item = element('div', 'git-row'),
      file = element('a', 'git-file', {href: '#git-diff'}),
      action = element('input', {type: 'checkbox'}), status = element('span', 'git-status'),
      state = {row, file, action, status};
    file.append(status, document.createTextNode(''));
    file.onclick = (event) => {
      event.preventDefault();
      openGitTab('git-diff', {path: state.row.path});
    };
    action.onchange = () => change(state.row, action);
    item.append(action, file);
    rowState.set(item, state);
    return item;
  }
  function updateRow(item, row) {
    const state = rowState.get(item), {file, action, status} = state,
      unstage = row.staged && !row.unstaged;
    state.row = row;
    status.dataset.status = row.unstagedStatus || row.stagedStatus;
    if (status.textContent !== row.status) status.textContent = row.status;
    if (file.lastChild.data !== ` ${row.path}`) file.lastChild.data = ` ${row.path}`;
    file.title = row.path;
    setCheckbox(row, action);
    action.setAttribute('aria-label', `${unstage ? 'Unstage' : 'Stage'} ${row.path}`);
    if (action.indeterminate) action.title = 'Partially staged; check to stage all changes';
    else action.removeAttribute('title');
  }
  function renderPage(page, index) {
    const existing = new Map([...page.children].map((item) => [rowState.get(item).row.path, item]));
    let cursor = page.firstElementChild;
    for (const row of rows.slice(index * pageSize, (index + 1) * pageSize)) {
      const item = existing.get(row.path) || createRow(row);
      existing.delete(row.path);
      if (item !== cursor) page.insertBefore(item, cursor);
      updateRow(item, row);
      cursor = item.nextElementSibling;
    }
    for (const item of existing.values()) item.remove();
  }
  const pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = pageIndex.get(entry.target);
      if (pages[index] !== entry.target) continue;
      if (entry.isIntersecting || index === pages.length - 1) {
        visiblePages.add(entry.target);
        renderPage(entry.target, index);
      } else {
        visiblePages.delete(entry.target);
        entry.target.replaceChildren();
      }
    }
  }, {root: list, rootMargin: '200px 0px'});
  function renderPages() {
    const count = Math.ceil(rows.length / pageSize);
    while (pages.length > count) {
      const page = pages.pop();
      pageObserver.unobserve(page);
      visiblePages.delete(page);
      page.remove();
    }
    while (pages.length < count) {
      const page = element('div', 'git-page');
      pageIndex.set(page, pages.length);
      pages.push(page);
      list.append(page);
      pageObserver.observe(page);
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i], last = i === pages.length - 1,
        wasLast = page.classList.contains('git-page-last');
      page.classList.toggle('git-page-last', last);
      if (last) visiblePages.add(page);
      else if (wasLast) { pageObserver.unobserve(page); pageObserver.observe(page); }
      if (visiblePages.has(page)) renderPage(page, i);
    }
  }
  async function refresh(changedPath = null) {
    if (pane.hidden) return false;
    const current = ++sequence, target = url();
    statusRequests++;
    if (!statusKnown) message.textContent = 'Loading Git status…';
    try {
      const data = JSON.parse(await responseText(await fetch(target, {credentials: 'same-origin'})));
      if (current !== sequence) return false;
      gitInfo = data;
      const branches = data.branches || [];
      const selectedBranch = branch.value;
      setBranchOptions(branch, !branches.length && data.branch ? [data.branch] : branches);
      if (hasBranchOption(branch, selectedBranch))
        branch.value = selectedBranch;
      else if (hasBranchOption(branch, data.branch))
        branch.value = data.branch;
      root.textContent = data.relativeRoot === '.' ? '' : data.relativeRoot;
      root.title = data.relativeRoot === '.' ? '' : data.root;
      root.hidden = data.relativeRoot === '.';
      rows = statusRows(data.changes);
      pushButton.textContent = data.ahead ? `Push (${data.ahead})` : 'Push';
      statusKnown = true;
      statusFailed = false;
      updateControls();
      message.textContent = rows.length ? '' : 'No changes';
      renderPages();
      if (!diff.hidden) {
        updateReview(changedPath);
        if (!changedPath) refreshDiffs();
      }
      return true;
    } catch (error) {
      if (current === sequence) {
        statusFailed = true;
        updateControls();
        message.textContent = statusKnown ? `Could not refresh Git status: ${error.message}` : error.message;
      }
      return false;
    } finally { statusRequests--; }
  }
  refreshButton.onclick = () => { if (!busy) refresh(); };
  function poll() {
    if (!pane.hidden && !document.hidden && !busy && !statusRequests) refresh();
  }
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', poll);
  return {
    refresh, closeDiff, showDiff, showHistory,
    setDirectory(next) {
      if (directory === next) return;
      directory = next;
      sequence++;
      historySequence++;
      closeDiff();
      statusKnown = false;
      statusFailed = false;
      rows = [];
      gitInfo = null;
      updateControls();
      branch.replaceChildren();
      root.textContent = message.textContent = '';
      pageObserver.disconnect();
      visiblePages.clear();
      pages.length = 0;
      list.replaceChildren();
      list.scrollTop = 0;
      refresh();
    },
  };
}
