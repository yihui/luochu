export function createTabset(bar, selectTab, closeTab) {
  const items = new Map();
  bar.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...bar.querySelectorAll('.tab-select')], index = buttons.indexOf(event.target);
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].click();
    buttons[next].focus();
  });
  return (tabs, active) => {
    for (const [key, item] of items) {
      if (!tabs.some((tab) => tab.key === key)) { item.remove(); items.delete(key); }
    }
    tabs.forEach((tab, index) => {
      let item = items.get(tab.key);
      if (!item) {
        item = document.createElement('span');
        item.className = 'tab';
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'tab-select';
        select.onclick = () => selectTab(tab.key);
        item.append(select);
        if (closeTab) {
          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'tab-close';
          close.textContent = '×';
          close.onclick = () => closeTab(tab.key);
          item.append(close);
        }
        items.set(tab.key, item);
      }
      item.classList.toggle('active', tab.key === active);
      const select = item.firstElementChild, close = item.lastElementChild;
      select.textContent = tab.label;
      select.title = tab.title || tab.label;
      if (tab.id) select.id = tab.id;
      select.setAttribute('aria-pressed', String(tab.key === active));
      if (closeTab) close.setAttribute('aria-label', `Close ${tab.title || tab.label}`);
      if (bar.children[index] !== item) bar.insertBefore(item, bar.children[index] || null);
    });
  };
}
