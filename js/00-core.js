/* NeoTab — core helpers. No dependencies, no build step, no network calls. */
(function (global) {
  'use strict';
  const NT = global.NT = global.NT || {};

  NT.isExtension = !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else if (key === 'style') node.setAttribute('style', attrs[key]);
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined && attrs[key] !== false) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function debounce(fn, wait) {
    let timer = 0;
    return function () {
      const args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function gradient(seed) {
    const h = hash(seed || 'neotab') % 360;
    return 'linear-gradient(145deg, hsl(' + h + ', 62%, 58%), hsl(' + ((h + 46) % 360) + ', 64%, 45%))';
  }

  function letter(title, url) {
    const t = String(title || '').trim();
    if (t) return /[\u3400-\u9fff]/.test(t[0]) ? t[0] : t.slice(0, 2).toUpperCase();
    try { return new URL(url).hostname.replace(/^www\./, '').slice(0, 2).toUpperCase(); }
    catch (e) { return 'N'; }
  }

  function normalizeUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^(javascript|data|vbscript):/i.test(value)) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.slice(0, 2) === '//') return value;
    return 'https://' + value;
  }

  function hostname(url) {
    try { return new URL(normalizeUrl(url)).hostname.replace(/^www\./, ''); }
    catch (e) { return String(url || ''); }
  }

  function openUrl(url, blank) {
    const target = normalizeUrl(url);
    if (!target) return;
    if (blank) global.open(target, '_blank', 'noopener,noreferrer');
    else global.location.href = target;
  }

  let toastTimer = 0;
  function toast(message, isError) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('is-error', !!isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2600);
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  function readDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  /* Downscale large photos so a wallpaper never blows the storage quota.
     Animated GIFs and SVGs are passed through untouched. */
  function compressImage(file, maxEdge, quality) {
    return readDataUrl(file).then(function (dataUrl) {
      if (/^data:image\/(gif|svg\+xml)/i.test(dataUrl)) return dataUrl;
      return new Promise(function (resolve) {
        const img = new Image();
        img.onload = function () {
          const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try { resolve(canvas.toDataURL('image/jpeg', quality)); }
          catch (e) { resolve(dataUrl); }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      });
    });
  }

  function formatTime(date, hour24, seconds) {
    let h = date.getHours();
    const suffix = hour24 ? '' : (h >= 12 ? ' PM' : ' AM');
    if (!hour24) h = h % 12 || 12;
    const pad = (n) => String(n).padStart(2, '0');
    return pad(h) + ':' + pad(date.getMinutes()) + (seconds ? ':' + pad(date.getSeconds()) : '') + suffix;
  }

  function formatDate(date) {
    const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日 · ' + week[date.getDay()];
  }

  const listeners = {};
  const bus = {
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit: function (name, payload) { (listeners[name] || []).forEach(function (fn) { fn(payload); }); }
  };

  NT.util = {
    $: $, $$: $$, el: el, clamp: clamp, uid: uid, debounce: debounce,
    hash: hash, gradient: gradient, letter: letter, normalizeUrl: normalizeUrl,
    hostname: hostname, openUrl: openUrl, toast: toast,
    download: download, readText: readText, readDataUrl: readDataUrl,
    compressImage: compressImage, formatTime: formatTime, formatDate: formatDate
  };
  NT.bus = bus;
})(window);
