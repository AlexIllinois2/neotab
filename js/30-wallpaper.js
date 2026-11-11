/* NeoTab — wallpaper.
   There is no separate wallpaper page: choosing a local image applies it at
   once. The settings panel only holds the preview, blur and mask controls. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;

  const PRESETS = [
    { id: 'nebula', name: '星云', css: 'url("assets/wallpaper-default.svg")' },
    { id: 'dusk', name: '暮色', css: 'linear-gradient(135deg, #241b3a 0%, #6b3f6e 48%, #d08a6a 100%)' },
    { id: 'ocean', name: '深海', css: 'linear-gradient(160deg, #041c32 0%, #0a4a68 52%, #14a0a8 100%)' },
    { id: 'forest', name: '松林', css: 'linear-gradient(145deg, #10241d 0%, #1f5139 55%, #8fae72 100%)' },
    { id: 'graphite', name: '石墨', css: 'linear-gradient(140deg, #16181d 0%, #333944 60%, #565c68 100%)' },
    { id: 'peach', name: '暖霞', css: 'linear-gradient(135deg, #3a2360 0%, #a6467d 50%, #f3a26c 100%)' }
  ];

  let uploaded = null;

  function config() { return NT.state.data.config.wallpaper; }

  function presetCss(id) {
    const found = PRESETS.find(function (p) { return p.id === id; });
    return found ? found.css : PRESETS[0].css;
  }

  function currentCss() {
    const cfg = config();
    if (cfg.kind === 'upload' && uploaded) return 'url("' + uploaded + '")';
    if (cfg.kind === 'color' && cfg.value) return 'none';
    if (cfg.kind === 'preset') return presetCss(cfg.preset);
    return presetCss('nebula');
  }

  function apply() {
    const cfg = config();
    const wall = U.$('#wallpaper');
    const css = currentCss();
    const bgColor = (cfg.kind === 'color' && cfg.value) ? cfg.value : '#101638';
    const blur = U.clamp(Number(cfg.blur) || 0, 0, 60);
    const mask = U.clamp(Number(cfg.mask) || 0, 0, 90) / 100;

    wall.style.backgroundImage = css;
    wall.style.backgroundColor = bgColor;
    wall.style.filter = 'blur(' + blur + 'px)';
    wall.style.transform = 'scale(' + (1.04 + blur / 900) + ')';
    document.documentElement.style.setProperty('--wall-mask', String(mask));

    U.$$('#wallPresets .preset').forEach(function (node) {
      node.classList.toggle('is-active', cfg.kind === 'preset' && node.dataset.preset === cfg.preset);
    });
  }

  function loadUploaded() {
    const cfg = config();
    if (cfg.kind !== 'upload') { uploaded = null; return Promise.resolve(); }
    return NT.blobs.get('wallpaper').then(function (data) {
      uploaded = typeof data === 'string' && data ? data : null;
      if (!uploaded) {
        cfg.kind = 'preset';
        cfg.preset = 'nebula';
        NT.state.save();
      }
      apply();
    });
  }

  async function useFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { U.toast('请选择图片文件', true); return; }
    try {
      U.toast('正在处理壁纸…');
      const data = await U.compressImage(file, 1920, 0.86);
      await NT.blobs.set('wallpaper', data);
      uploaded = data;
      const cfg = config();
      cfg.kind = 'upload';
      cfg.value = '';
      cfg.preset = '';
      cfg.name = file.name;
      NT.state.changed({ wallpaper: true });
      U.toast('壁纸已应用');
    } catch (e) {
      U.toast('壁纸读取失败：' + (e && e.message ? e.message : '未知错误'), true);
    }
  }

  function pickFile() {
    const input = U.$('#wallpaperFile');
    input.value = '';
    input.click();
  }

  function setPreset(id) {
    const cfg = config();
    cfg.kind = 'preset';
    cfg.preset = id;
    cfg.value = '';
    cfg.name = '';
    NT.state.changed({ wallpaper: true });
  }

  function reset() {
    const cfg = config();
    cfg.kind = 'preset';
    cfg.preset = 'nebula';
    cfg.value = '';
    cfg.name = '';
    cfg.blur = 6;
    cfg.mask = 14;
    uploaded = null;
    NT.blobs.remove('wallpaper').catch(function () {});
    NT.state.changed({ wallpaper: true });
    U.toast('已恢复默认壁纸');
  }

  function setBlur(value) { config().blur = U.clamp(Number(value), 0, 40); NT.state.changed({ wallpaper: true }); }
  function setMask(value) { config().mask = U.clamp(Number(value), 0, 90); NT.state.changed({ wallpaper: true }); }

  function initPresets() {
    const row = U.$('#wallPresets');
    if (!row) return;
    PRESETS.forEach(function (preset) {
      const node = U.el('button', {
        type: 'button', class: 'preset', title: preset.name, 'data-preset': preset.id,
        style: 'background:' + preset.css,
        onclick: function () { setPreset(preset.id); }
      });
      row.appendChild(node);
    });
  }

  function init() {
    initPresets();
    const input = U.$('#wallpaperFile');
    input.addEventListener('change', function () { useFile(input.files && input.files[0]); });
    U.$('#btnChangeWallpaper').addEventListener('click', pickFile);
    U.$('#btnResetWallpaper').addEventListener('click', reset);

    // Dropping an image anywhere on the page also applies it immediately.
    // Guards: drops inside the icon grid / folder popup are internal drags
    // (e.g. an icon tile), never wallpaper material — otherwise dragging an
    // icon could silently replace the wallpaper with its favicon (Chrome
    // exposes a dragged <img> as a File in dataTransfer.files).
    document.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault();
    });
    document.addEventListener('drop', function (e) {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length || !/^image\//.test(files[0].type)) return;
      if (e.target.closest && e.target.closest('.tile, .grid, .desk-track, .folder-dialog, .search-item-icon')) return;
      try {
        const payload = JSON.parse(e.dataTransfer.getData('text/plain') || 'null');
        if (payload && payload.kind) return;
      } catch (err) { /* 普通文件拖入，不是 JSON 载荷 */ }
      if (U.$('#dialogLayer').hidden === false || U.$('#settings').hidden === false) return;
      e.preventDefault();
      useFile(files[0]);
    });
  }

  NT.wallpaper = {
    PRESETS: PRESETS, init: init, apply: apply, loadUploaded: loadUploaded,
    useFile: useFile, pickFile: pickFile, setPreset: setPreset, reset: reset,
    setBlur: setBlur, setMask: setMask
  };
})(window);
