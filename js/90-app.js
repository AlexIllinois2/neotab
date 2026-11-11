/* NeoTab — bootstrap and render coordination. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;

  function applyChrome() {
    const cfg = NT.state.data.config;
    U.$('#btnNotes').hidden = !cfg.notesShow;
    U.$('#stage').classList.toggle('has-hero', !U.$('#hero').hidden);
  }

  function renderAll() {
    NT.desks.render();
    NT.grid.render();
    NT.search.applyConfig();
    NT.wallpaper.apply();
    NT.settings.sync();
    applyChrome();
  }

  function onStateChange(flags) {
    flags = flags || {};
    if (flags.all || flags.desks || flags.config) NT.desks.render();
    if (flags.all || flags.grid || flags.desks) NT.grid.render();
    else if (flags.config) NT.grid.layout();
    if (flags.all || flags.config) NT.search.applyConfig();
    if (flags.all || flags.wallpaper) NT.wallpaper.apply();
    NT.settings.sync();
    applyChrome();
  }

  function bindApp() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!U.$('#contextMenu').hidden) { NT.dialogs.closeMenu(); return; }
      if (!U.$('#dialogLayer').hidden) { NT.dialogs.closeDialog(); return; }
      if (!U.$('#folderLayer').hidden) { NT.dialogs.closeFolder(); return; }
      if (!U.$('#globalSearchLayer').hidden) { NT.search.closeFinder(); return; }
      if (NT.settings.isOpen()) { NT.settings.close(); return; }
      U.$('#notesPanel').hidden = true;
    });
  }

  function start() {
    NT.dialogs.init();
    NT.grid.init();
    NT.desks.init();
    NT.wallpaper.init();
    NT.search.init();
    NT.settings.init();
    NT.bus.on('state:change', onStateChange);

    NT.state.load()
      .then(function () { return NT.wallpaper.loadUploaded(); })
      .then(function () {
        renderAll();
        bindApp();
        document.body.dataset.ready = '1';
        NT.bus.emit('ready');
      })
      .catch(function (err) {
        renderAll();
        bindApp();
        U.toast('初始化出现问题：' + (err && err.message ? err.message : '未知错误'), true);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
