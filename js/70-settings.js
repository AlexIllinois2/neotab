/* NeoTab — settings panel.
   Deliberately small: the icon tab exposes ONE control (column count), and the
   wallpaper tab replaces the old standalone wallpaper page. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;

  const TAB_META = {
    icon: { title: '图标' },
    wallpaper: { title: '壁纸' },
    general: { title: '通用' },
    sync: { title: '同步' }
  };
  const COLS = [0, 4, 5, 6, 7, 8, 9, 10, 12];
  let currentTab = 'icon';

  function config() { return NT.state.data.config; }

  function open(tab) {
    U.$('#settings').hidden = false;
    switchTab(tab || currentTab);
    syncAll();
  }
  function close() {
    U.$('#settings').hidden = true;
    if (NT.webdav) NT.webdav.closeInline();
  }
  function isOpen() { return !U.$('#settings').hidden; }

  function switchTab(id) {
    if (!TAB_META[id]) id = 'icon';
    currentTab = id;
    U.$$('#settingsNav .nav-item').forEach(function (n) { n.classList.toggle('is-active', n.dataset.tab === id); });
    U.$$('#settingsContent .panel').forEach(function (n) { n.classList.toggle('is-active', n.dataset.panel === id); });
    U.$('#settingsTitle').textContent = TAB_META[id].title;
    U.$('#settingsContent').scrollTop = 0;
    if (id === 'icon') renderPreview();
    // 同步面板由 WebDAV 模块内嵌进宿主，离开该 tab 时收起。
    if (NT.webdav) {
      if (id === 'sync') NT.webdav.openInline(U.$('.webdav-inline-host'));
      else NT.webdav.closeInline();
    }
  }

  /* ---- icon tab: column count only ---------------------------------------- */
  function renderChips() {
    const row = U.$('#colsChips');
    row.textContent = '';
    COLS.forEach(function (value) {
      row.appendChild(U.el('button', {
        type: 'button', class: 'chip', text: value === 0 ? '自动' : String(value),
        'data-cols': String(value),
        onclick: function () {
          config().cols = value;
          NT.state.changed({ grid: true, config: true });
          syncAll();
        }
      }));
    });
  }

  function renderPreview() {
    const box = U.$('#colsPreview');
    if (!box) return;
    const cols = NT.grid.layout().cols;
    box.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    box.textContent = '';
    for (let i = 0; i < cols * 2; i++) box.appendChild(U.el('i'));
  }

  /* ---- wallpaper tab ------------------------------------------------------- */
  function updateRange(node) {
    const min = Number(node.min) || 0, max = Number(node.max) || 100;
    const pct = ((Number(node.value) - min) / (max - min)) * 100;
    node.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  function syncWallpaper() {
    const wall = config().wallpaper;
    const blur = U.$('#blurRange'), mask = U.$('#maskRange');
    blur.value = wall.blur;
    mask.value = wall.mask;
    U.$('#blurOut').textContent = wall.blur + ' px';
    U.$('#maskOut').textContent = wall.mask + ' %';
    updateRange(blur); updateRange(mask);
  }

  /* ---- general tab --------------------------------------------------------- */
  const SWITCHES = {
    optIconBlank: 'iconBlank', optSearchBlank: 'searchBlank',
    optSearchShow: 'searchShow', optClockShow: 'clockShow',
    optClock24: 'clock24', optNotesShow: 'notesShow',
    optAutoIcon: 'autoIcon', optIconService: 'iconService'
  };

  function syncAll() {
    const cfg = config();
    Object.keys(SWITCHES).forEach(function (id) { U.$('#' + id).checked = !!cfg[SWITCHES[id]]; });
    U.$('#optEngine').value = NT.ENGINES[cfg.engine] ? cfg.engine : 'bing';
    U.$$('#colsChips .chip').forEach(function (chip) {
      chip.classList.toggle('is-active', Number(chip.dataset.cols) === Number(cfg.cols || 0));
    });
    syncWallpaper();
    renderPreview();
  }

  /* ---- backup / reset (buttons live in the sync panel) --------------------- */
  function exportBackup() {
    const data = NT.state.data;
    NT.util.download('neotab-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify({
        format: 'neotab', version: 1, exportedAt: new Date().toISOString(),
        config: data.config, desks: data.desks, activeDeskId: data.activeDeskId,
        notes: data.notes, todos: data.todos
      }, null, 2));
    U.toast('备份已导出');
  }

  function importBackup(file) {
    if (!file) return;
    U.readText(file).then(function (text) {
      const result = NT.backup.read(text);
      NT.dialogs.confirm('导入备份',
        '将导入 ' + result.stats.desks + ' 个桌面、约 ' + result.stats.items + ' 个图标。当前数据会被替换。',
        function () {
          NT.state.replace(result.data);
          close();
          U.toast('导入完成：' + result.stats.desks + ' 个桌面');
        });
    }).catch(function (err) {
      U.toast('导入失败：' + (err && err.message ? err.message : '文件不是有效的 NeoTab 备份'), true);
    });
  }

  function bind() {
    U.$$('[data-close-settings]').forEach(function (node) { node.addEventListener('click', close); });
    U.$$('#settingsNav .nav-item').forEach(function (node) {
      node.addEventListener('click', function () { switchTab(node.dataset.tab); });
    });
    U.$('#btnBrand').addEventListener('click', function () { open(); });

    Object.keys(SWITCHES).forEach(function (id) {
      U.$('#' + id).addEventListener('change', function (e) {
        config()[SWITCHES[id]] = e.target.checked;
        // Icon switches change which hosts may be contacted: drop cached
        // hits/misses so the next render resolves from the new policy.
        if (id === 'optAutoIcon' || id === 'optIconService') NT.icons.clear();
        NT.state.changed({ config: true, grid: true });
      });
    });
    U.$('#btnRefreshIcons').addEventListener('click', function () { NT.icons.refreshAll(); });
    U.$('#optEngine').addEventListener('change', function (e) {
      config().engine = e.target.value;
      NT.state.changed({ config: true });
    });

    U.$('#blurRange').addEventListener('input', function (e) { NT.wallpaper.setBlur(e.target.value); syncWallpaper(); });
    U.$('#maskRange').addEventListener('input', function (e) { NT.wallpaper.setMask(e.target.value); syncWallpaper(); });

    U.$('#btnExport').addEventListener('click', exportBackup);
    U.$('#btnImport').addEventListener('click', function () {
      const input = U.$('#backupFile'); input.value = ''; input.click();
    });
    U.$('#backupFile').addEventListener('change', function (e) { importBackup(e.target.files && e.target.files[0]); });
    U.$('#btnResetAll').addEventListener('click', function () {
      NT.dialogs.confirm('重置全部数据', '将清空桌面、图标、壁纸、便签与所有设置，且无法撤销。', function () {
        NT.state.reset();
        close();
        U.toast('已恢复初始状态');
      });
    });
  }

  NT.settings = {
    init: function () { renderChips(); bind(); syncAll(); },
    open: open, close: close, isOpen: isOpen, switchTab: switchTab,
    sync: syncAll, renderPreview: renderPreview
  };
})(window);
