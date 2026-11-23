export function diffLineNumbers(text) {
  const lines = text.split('\n'), numbers = [];
  if (text.endsWith('\n')) lines.pop();
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

export function createGitPane(pane, apiUrl, initialDirectory, openFile) {
  let directory = initialDirectory, sequence = 0, diffSequence = 0, statusRequests = 0, busy = false, rows = [],
    statusKnown = false, statusFailed = false, observer = null, reviewItems = [], pendingTarget = null;
  const header = document.createElement('div'), branch = document.createElement('strong'),
    refreshButton = document.createElement('button'), root = document.createElement('div'),
    message = document.createElement('div'), list = document.createElement('div'),
    diff = document.querySelector('#git-diff'),
    diffTitle = document.querySelector('#git-diff-title'), diffContent = document.querySelector('#git-diff-content'),
    main = document.querySelector('main'), reviewByElement = new WeakMap();
  header.className = 'git-header';
  refreshButton.type = 'button';
  refreshButton.textContent = 'Refresh';
  header.append(branch, refreshButton);
  root.className = 'git-root';
  message.className = 'git-message';
  message.setAttribute('role', 'status');
  list.className = 'git-list';
  pane.replaceChildren(header, root, message, list);

  const url = (params = {}) => apiUrl(`api/git?${new URLSearchParams({dir: directory, ...params})}`);
  async function responseText(response) {
    const text = await response.text();
    if (!response.ok) throw new Error(text.trim() || `Request failed: ${response.status}`);
    return text;
  }
  function closeDiff() {
    diffSequence++;
    observer?.disconnect();
    observer = null;
    for (const item of reviewItems) item.controller?.abort();
    reviewItems = [];
    pendingTarget = null;
    diff.hidden = true;
    main.classList.remove('show-git-diff');
  }
  document.querySelector('#git-diff-close').onclick = closeDiff;
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
    diffContent.addEventListener(event, () => { pendingTarget = null; });
  function navigateDiff(selected) {
    const item = selected && reviewItems.find(({row}) => row.path === selected.path);
    if (!item) return;
    item.section.open = true;
    pendingTarget = item;
    item.section.scrollIntoView({block: 'start'});
  }
  function renderDiff(item, text) {
    const scroller = document.createElement('div'), source = document.createElement('pre'),
      numbers = diffLineNumbers(text), lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    scroller.className = 'git-diff-scroll';
    source.className = 'git-diff-text';
    const fragment = document.createDocumentFragment();
    numbers.forEach(({old, current}, index) => {
      const row = document.createElement('span'), oldGutter = document.createElement('span'),
        newGutter = document.createElement('span'), line = document.createElement('span');
      row.className = 'git-diff-row';
      oldGutter.className = 'git-gutter git-old-gutter';
      if (old !== null) oldGutter.dataset.line = old;
      newGutter.className = 'git-gutter git-new-gutter';
      if (current) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.line = current;
        button.setAttribute('aria-label', `Open ${item.row.path} at line ${current}`);
        if (!item.row.projectPath) {
          button.disabled = true;
          button.title = 'File is outside the project root';
        }
        newGutter.append(button);
      }
      line.className = 'git-diff-line';
      line.textContent = lines[index] + (index < lines.length - 1 || text.endsWith('\n') ? '\n' : '');
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
    if (!observer || pane.hidden || document.hidden || !item.section.isConnected ||
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
          else item.content.textContent = '(No textual diff)';
        }
        item.text = text;
        item.loaded = true;
      }
    }).catch((error) => {
      if (current === diffSequence && version === item.version) {
        item.loaded = false;
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
    const section = document.createElement('details'), summary = document.createElement('summary'),
      heading = document.createElement('h3'), content = document.createElement('div'),
      item = {row, section, heading, content, loading: false, loaded: false, stale: true, visible: false,
        text: null, version: 0, controller: null};
    section.className = 'git-diff-file';
    section.open = true;
    content.textContent = 'Waiting to load…';
    summary.append(heading);
    section.append(summary, content);
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
    diffTitle.textContent = 'Changes';
    diff.hidden = false;
    main.classList.add('show-git-diff');
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
    sequence++;
    checkbox.setAttribute('aria-busy', 'true');
    const target = url(), currentDirectory = directory, unstage = row.staged && !row.unstaged;
    pendingTarget = null;
    message.textContent = '';
    try {
      await responseText(await fetch(target, {
        method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: row.path, group: unstage ? 'staged' : 'unstaged',
          action: unstage ? 'unstage' : 'stage'}),
      }));
      if (directory === currentDirectory && !await refresh(row.path)) setCheckbox(row, checkbox);
    } catch (error) {
      if (directory === currentDirectory) {
        setCheckbox(row, checkbox);
        message.textContent = `Git operation failed: ${error.message}`;
      }
    } finally { busy = false; checkbox.removeAttribute('aria-busy'); }
  }
  const pageSize = 40, pages = [], visiblePages = new Set(), pageIndex = new WeakMap(),
    rowState = new WeakMap();
  function createRow(row) {
    const item = document.createElement('div'), file = document.createElement('a'),
      action = document.createElement('input'), status = document.createElement('span'),
      state = {row, file, action, status};
    item.className = 'git-row';
    file.href = '#git-diff';
    file.className = 'git-file';
    status.className = 'git-status';
    file.append(status, document.createTextNode(''));
    file.onclick = (event) => {
      event.preventDefault();
      showDiff({path: state.row.path});
    };
    action.type = 'checkbox';
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
      const page = document.createElement('div');
      page.className = 'git-page';
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
      branch.textContent = data.branch || 'Detached HEAD';
      root.textContent = data.relativeRoot === '.' ? '' : data.relativeRoot;
      root.title = data.relativeRoot === '.' ? '' : data.root;
      root.hidden = data.relativeRoot === '.';
      rows = statusRows(data.changes);
      statusKnown = true;
      statusFailed = false;
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
    refresh, closeDiff,
    setDirectory(next) {
      if (directory === next) return;
      directory = next;
      sequence++;
      closeDiff();
      statusKnown = false;
      statusFailed = false;
      rows = [];
      branch.textContent = root.textContent = message.textContent = '';
      pageObserver.disconnect();
      visiblePages.clear();
      pages.length = 0;
      list.replaceChildren();
      list.scrollTop = 0;
      refresh();
    },
  };
}
