/* NeoTab — automatic site icon resolution.
 *
 * Resolution order (every network step can be turned off in Settings → 通用):
 *   1. a URL / data URL the user set on the tile (including uploaded icons),
 *   2. a previously resolved URL from a small localStorage cache,
 *   3. Chrome's own `_favicon/` cache (extension only — the existing
 *      "favicon" permission, no host permissions and no extra requests),
 *   4. the site's own /favicon.ico and apple-touch-icon files,
 *   5. optionally a public icon service (off by default).
 *
 * Only hosts the user added are ever contacted. Nothing is uploaded, no
 * analytics, no fixed third-party endpoint unless step 5 is explicitly
 * enabled. Unresolvable tiles fall back to their generated letter icon.
 * The cache stores URLs, never image bytes, so no canvas/CORS workarounds.
 */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;

  const CACHE_KEY = 'neotab.iconCache.v1';
  const OK_TTL = 30 * 24 * 60 * 60 * 1000;   // resolved URL: 30 days
  const FAIL_TTL = 30 * 60 * 1000;           // known miss: retry after 30 min
  let cache = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
    catch (e) { /* quota — the in-memory copy still serves this session */ }
  }
  function config() {
    return (NT.state && NT.state.data && NT.state.data.config) || {};
  }
  function host(url) {
    try { return new URL(U.normalizeUrl(url)).hostname.replace(/^www\./, '').toLowerCase(); }
    catch (e) { return ''; }
  }
  function origin(url) {
    try { return new URL(U.normalizeUrl(url)).origin; }
    catch (e) { return ''; }
  }
  function chromeFavicon(url, size) {
    if (!NT.isExtension || !url) return '';
    try {
      const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
      favicon.searchParams.set('pageUrl', U.normalizeUrl(url));
      favicon.searchParams.set('size', String(size));
      return favicon.toString();
    } catch (e) { return ''; }
  }

  /* Ordered, de-duplicated list of image URLs to try for one tile. */
  function candidates(item) {
    if (!item) return [];
    const manual = item.icon ? [item.icon] : [];
    if (item.textIcon) return manual;
    const cfg = config();
    const h = host(item.url);
    const base = origin(item.url);
    if (cfg.autoIcon === false || !h || !base || !/^https?:$/.test(new URL(base).protocol)) return manual;

    const hit = cache[h];
    const fresh = hit && Date.now() - (Number(hit.ts) || 0) < (hit.src ? OK_TTL : FAIL_TTL);
    if (fresh && !hit.src) return manual;               // known miss: stay offline
    const list = [];
    if (fresh && hit.src) list.push(hit.src);            // verified: fastest path
    if (NT.isExtension) {
      const f64 = chromeFavicon(item.url, 64);
      const f32 = chromeFavicon(item.url, 32);
      if (f64) list.push(f64);
      if (f32) list.push(f32);
    }
    list.push(
      base + '/favicon.ico',
      base + '/apple-touch-icon.png',
      base + '/apple-touch-icon-precomposed.png'
    );
    if (cfg.iconService) list.push('https://icons.duckduckgo.com/ip3/' + h + '.ico');

    const seen = {};
    return manual.concat(list).filter(function (src) {
      if (!src || typeof src !== 'string' || seen[src]) return false;
      seen[src] = 1;
      return true;
    });
  }

  function remember(h, src) {
    if (!h || !src || /^data:/i.test(src)) return;      // uploaded icons live on the item
    cache[h] = { src: src, ts: Date.now() };
    save();
  }
  function miss(h) {
    if (!h) return;
    // Several tiles can share a host and resolve concurrently; a late miss
    // must not erase an icon that another tile already verified.
    if (cache[h] && cache[h].src) return;
    cache[h] = { src: null, ts: Date.now() };
    save();
  }

  /* Attach a cascading loader to an <img> inside an icon box. Each failure
     advances to the next candidate; a 0×0 image counts as a failure. */
  function apply(img, box, item) {
    const list = candidates(item);
    const h = host(item && item.url);
    let index = 0, settled = false;
    // A slow or unreachable host must never leave a blank square: show the
    // letter as a placeholder, then swap in the image if it arrives later.
    const placeholder = setTimeout(function () {
      if (!settled) box.classList.add('is-letter');
    }, 4000);

    function fallback() {
      settled = true;
      clearTimeout(placeholder);
      if (img.parentNode) img.remove();
      box.classList.add('is-letter');
      if (h && config().autoIcon !== false) miss(h);
    }
    function next() {
      if (settled) return;
      if (index >= list.length) { fallback(); return; }
      img.src = list[index];
    }
    img.addEventListener('error', function () { index += 1; next(); });
    img.addEventListener('load', function () {
      if (settled) return;
      if (!img.naturalWidth || !img.naturalHeight) { index += 1; next(); return; }
      settled = true;
      clearTimeout(placeholder);
      img.classList.add('is-ready');
      box.classList.remove('is-letter');
      if (h && config().autoIcon !== false) remember(h, list[index]);
    });
    if (!list.length) fallback();
    else next();
  }

  function forget(url) {
    const h = host(url);
    if (h) { delete cache[h]; save(); }
  }
  function clear() {
    Object.keys(cache).forEach(function (key) { delete cache[key]; });
    save();
  }
  function refreshAll() {
    clear();
    if (NT.grid && NT.grid.render) NT.grid.render();
    U.toast('已清空图标缓存并重新解析');
  }
  function count() { return Object.keys(cache).length; }

  NT.icons = {
    candidates: candidates, apply: apply, forget: forget,
    clear: clear, refreshAll: refreshAll, count: count
  };
})(window);
