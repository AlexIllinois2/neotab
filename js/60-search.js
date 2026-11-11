/* NeoTab — search bar, clock, global finder, quick notes. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;
  let results = [];
  let activeIndex = 0;

  function config() { return NT.state.data.config; }

  function applyConfig() {
    const cfg = config();
    const hero = U.$('#hero');
    U.$('#clock').hidden = !cfg.clockShow;
    U.$('#searchForm').hidden = !cfg.searchShow;
    hero.hidden = !cfg.clockShow && !cfg.searchShow;
    const engine = NT.ENGINES[cfg.engine] || NT.ENGINES.bing;
    U.$('#engineBtn').textContent = engine.title;
  }

  function tick() {
    const now = new Date();
    U.$('#clockTime').textContent = U.formatTime(now, config().clock24 !== false, false);
    U.$('#clockDate').textContent = U.formatDate(now);
  }

  function nextEngine() {
    const keys = Object.keys(NT.ENGINES);
    const index = keys.indexOf(config().engine);
    config().engine = keys[(index + 1 + keys.length) % keys.length];
    applyConfig();
    NT.state.changed({});
    U.toast('搜索引擎：' + NT.ENGINES[config().engine].title);
  }

  function bindSearchBar() {
    U.$('#engineBtn').addEventListener('click', nextEngine);
    U.$('#searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const q = U.$('#searchInput').value.trim();
      if (!q) return;
      const looksLikeUrl = /^(https?:\/\/|localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+(\/|$))/i.test(q);
      const engine = NT.ENGINES[config().engine] || NT.ENGINES.bing;
      U.openUrl(looksLikeUrl ? U.normalizeUrl(q) : engine.href + encodeURIComponent(q), config().searchBlank);
    });
  }

  /* ---- global finder ------------------------------------------------------- */
  function collect(query) {
    const q = query.toLowerCase();
    const found = [];
    NT.state.allItems().forEach(function (entry) {
      const item = entry.item;
      const hay = ((item.title || '') + ' ' + (item.url || '') + ' ' + (entry.desk.name || '')).toLowerCase();
      if (!q || hay.indexOf(q) >= 0) {
        found.push({ title: item.title || '未命名', sub: entry.parent ? entry.desk.name + ' / ' + entry.parent.title : entry.desk.name, url: item.url || '', id: item.id, type: item.type });
      }
    });
    return found.slice(0, 40);
  }

  function renderResults() {
    const box = U.$('#globalSearchResults');
    box.textContent = '';
    if (!results.length) {
      box.appendChild(U.el('div', { class: 'search-empty', text: '没有匹配的图标或书签' }));
      return;
    }
    results.forEach(function (entry, index) {
      const node = U.$('#tplSearchItem').content.firstElementChild.cloneNode(true);
      node.classList.toggle('is-active', index === activeIndex);
      U.$('strong', node).textContent = entry.title;
      U.$('small', node).textContent = entry.sub;
      const iconBox = U.$('.search-item-icon', node);
      const letter = U.$('.tile-letter', node);
      const img = U.$('img', node);
      letter.textContent = U.letter(entry.title, entry.url);
      letter.style.background = entry.color && entry.color !== 'transparent' ? entry.color : 'transparent';
      iconBox.classList.add('is-letter');
      NT.icons.apply(img, iconBox, { type: 'link', url: entry.url, icon: entry.icon || '' });
      node.addEventListener('click', function () { activate(index); });
      box.appendChild(node);
    });
  }

  function activate(index) {
    const entry = results[index];
    if (!entry) return;
    closeFinder();
    if (entry.type === 'folder') NT.dialogs.openFolderGate(entry.id);
    else if (entry.url) U.openUrl(entry.url, config().iconBlank);
  }

  function updateResults(query) {
    results = collect(query);
    activeIndex = 0;
    renderResults();
    // Bookmarks are browser-local as well; no network is involved.
    if (!NT.isExtension || !chrome.bookmarks || !query) return;
    const token = query;
    const pending = new Promise(function (resolve, reject) {
      try {
        const result = chrome.bookmarks.search(query, function (nodes) { resolve(nodes); });
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      } catch (e) { reject(e); }
    });
    pending.then(function (nodes) {
      if (U.$('#globalSearchInput').value !== token) return;
      (nodes || []).slice(0, 8).forEach(function (node) {
        if (!node.url) return;
        results.push({ title: node.title || U.hostname(node.url), sub: '书签 · ' + U.hostname(node.url), url: node.url, type: 'link' });
      });
      renderResults();
    }).catch(function () {});
  }

  function openFinder() {
    U.$('#globalSearchLayer').hidden = false;
    const input = U.$('#globalSearchInput');
    input.value = '';
    updateResults('');
    input.focus();
  }
  function closeFinder() { U.$('#globalSearchLayer').hidden = true; }

  function bindFinder() {
    const input = U.$('#globalSearchInput');
    input.addEventListener('input', U.debounce(function () { updateResults(input.value.trim()); }, 90));
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        renderResults();
      } else if (e.key === 'Enter') { e.preventDefault(); activate(activeIndex); }
    });
    U.$('#globalSearchLayer').addEventListener('click', function (e) {
      if (e.target.id === 'globalSearchLayer') closeFinder();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFinder();
      }
    });
  }

  /* ---- quick notes --------------------------------------------------------- */
  function bindNotes() {
    const panel = U.$('#notesPanel');
    const text = U.$('#notesText');
    const save = U.debounce(function () {
      NT.state.data.notes = text.value;
      NT.state.changed({});
      U.$('#notesStatus').textContent = '已自动保存';
    }, 350);
    U.$('#btnNotes').addEventListener('click', function () {
      text.value = NT.state.data.notes || '';
      panel.hidden = !panel.hidden;
      if (!panel.hidden) text.focus();
    });
    U.$('#btnNotesClose').addEventListener('click', function () { panel.hidden = true; });
    text.addEventListener('input', function () { U.$('#notesStatus').textContent = '正在保存…'; save(); });
  }

  NT.search = {
    init: function () {
      bindSearchBar(); bindFinder(); bindNotes();
      applyConfig(); tick();
      setInterval(tick, 1000);
    },
    applyConfig: applyConfig, openFinder: openFinder, closeFinder: closeFinder
  };
})(window);
