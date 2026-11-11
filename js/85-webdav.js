/*
 * NeoTab — WebDAV cloud backup and multi-device sync
 *
 * Self-contained module. It owns credential handling, collection creation,
 * backup upload / rotation, restore, debounced push after every local change,
 * and the settings panel together with its styles.
 *
 * The page contract is deliberately small:
 *   NT.state.data / NT.state.replace   read and replace the single state object
 *   NT.backup.read                     decode a NeoTab backup into state
 *   NT.util.toast                      transient feedback
 *   NT.bus ('state:change', 'ready')   change notification and startup signal
 *
 * Backup decoding lives in the state layer. This module only moves bytes and
 * therefore never needs to know the fields inside a backup.
 */
(() => {
  'use strict';

  const NT = window.NT;

  /* ---- constants ---------------------------------------------------------- */
  const SETTINGS_KEY = 'webdavConfig';
  const BACKUP_DIR = 'neotab-backup';
  const AUTO_KEEP_LIMIT = 10;
  const PUSH_DELAY = 3000;
  const SILENCE_AFTER_PULL = 15000;
  const STATUS_LIFETIME = 6000;
  const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>';
  const BODY_METHODS = ['PUT', 'PROPFIND', 'MKCOL'];

  /* ---- persisted settings -------------------------------------------------- */
  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg));
  }

  /* ---- credentials and diagnostics ----------------------------------------- */
  function encodeCredential(raw) {
    // Latin-1 credentials are sent byte-for-byte, matching the common server
    // decoding; wider characters use the UTF-8 variant of RFC 7617.
    let latin = true;
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) > 0xFF) { latin = false; break; }
    }
    return latin
      ? btoa(raw)
      : btoa(String.fromCharCode.apply(null, new TextEncoder().encode(raw)));
  }

  function explainFailure(res, url) {
    if (res.status === 401) {
      return '认证失败(401)：请检查用户名/密码是否正确（坚果云需在网页端「安全选项」生成应用密码，不能用登录密码）；若地址有重定向请直接填写最终 https 地址';
    }
    if (res.status === 403) return '无访问权限(403)：请确认该账号对此目录有读写权限';
    if (res.redirected && url) {
      try {
        if (new URL(res.url).origin !== new URL(url).origin) {
          return '服务器发生跨域重定向导致认证头被浏览器剥离，请把服务器地址改为：' + res.url;
        }
      } catch (e) { /* unparsable location: keep the status below */ }
    }
    return 'HTTP ' + res.status;
  }

  function requestHostPermission(url) {
    return new Promise((resolve) => {
      try {
        if (!window.chrome || !chrome.permissions) return resolve(true);
        const origin = new URL(url).origin + '/*';
        chrome.permissions.contains({ origins: [origin] }, (has) => {
          if (has) return resolve(true);
          chrome.permissions.request({ origins: [origin] }, (ok) => resolve(!!ok));
        });
      } catch (e) {
        // Outside an extension, let fetch surface any CORS problem itself.
        resolve(true);
      }
    });
  }

  /* ---- DAV transport ------------------------------------------------------- */
  function joinUrl(base, path) {
    return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
  }

  function sendDav(url, method, body, extraHeaders) {
    const cfg = getConfig();
    const headers = Object.assign({}, extraHeaders || {});
    if (cfg.username || cfg.password) {
      headers.Authorization = 'Basic ' + encodeCredential((cfg.username || '') + ':' + (cfg.password || ''));
    }
    return fetch(url, {
      method: method,
      headers: headers,
      body: BODY_METHODS.indexOf(method) >= 0 ? body : undefined
    });
  }

  async function putFile(path, content) {
    return sendDav(joinUrl(getConfig().url, path), 'PUT', content, { 'Content-Type': 'application/json' });
  }

  async function getFile(path) {
    const url = joinUrl(getConfig().url, path);
    const res = await sendDav(url, 'GET');
    if (!res.ok) throw new Error('下载失败: ' + explainFailure(res, url));
    return res.text();
  }

  async function deleteFile(path) {
    return sendDav(joinUrl(getConfig().url, path), 'DELETE');
  }

  async function makeCollection(path) {
    // Collections must end with a slash: some servers redirect an unslashed
    // MKCOL and the followed redirect would silently downgrade it to GET.
    let url = joinUrl(getConfig().url, path);
    if (!/\/$/.test(url)) url += '/';
    const res = await sendDav(url, 'MKCOL');
    if (res.ok || res.status === 405) return res; // 405 means it already exists
    throw new Error('创建目录失败: ' + explainFailure(res, url));
  }

  async function ensureDirectory() {
    let current = '';
    for (const segment of BACKUP_DIR.split('/').filter(Boolean)) {
      current += '/' + segment;
      await makeCollection(current);
    }
  }

  async function davList(path) {
    const url = joinUrl(getConfig().url, path);
    const res = await sendDav(url + '/', 'PROPFIND', PROPFIND_BODY, {
      Depth: '1', 'Content-Type': 'application/xml'
    });
    if (res.status === 404) return [];
    if (!res.ok && res.status !== 207) throw new Error('读取目录失败: ' + explainFailure(res, url));

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const nodes = Array.prototype.slice.call(doc.getElementsByTagName('*'));
    const files = [];
    let current = null;
    for (const node of nodes) {
      const tag = node.localName;
      if (tag === 'response') {
        current = { name: '', time: 0, size: 0 };
        files.push(current);
      } else if (current && tag === 'href') {
        const href = decodeURIComponent(node.textContent || '');
        current.name = href.replace(/\/+$/, '').split('/').pop();
      } else if (current && tag === 'getlastmodified') {
        current.time = Date.parse(node.textContent) || 0;
      } else if (current && tag === 'getcontentlength') {
        current.size = parseInt(node.textContent, 10) || 0;
      }
    }
    return files.filter((f) => f.name && /\.json$/i.test(f.name));
  }

  async function putWithRetry(path, content) {
    const url = joinUrl(getConfig().url, path);
    let res = await putFile(path, content);
    if (res.status === 409 || res.status === 404) {
      // Missing parent collection: create it and try once more.
      await ensureDirectory();
      res = await putFile(path, content);
      if (res.ok) return res;
      throw new Error('上传失败: ' + explainFailure(res, url) + '（已尝试创建目录）');
    }
    if (!res.ok) throw new Error('上传失败: ' + explainFailure(res, url));
    return res;
  }

  /* ---- state bridge -------------------------------------------------------- */
  async function collectData() {
    const d = NT.state.data;
    return {
      format: 'neotab', version: 1,
      config: d.config, desks: d.desks, activeDeskId: d.activeDeskId,
      notes: d.notes, todos: d.todos
    };
  }

  function applyData(data) {
    const result = NT.backup.read(data);
    NT.state.replace(result.data);
    return result;
  }

  /* ---- backup -------------------------------------------------------------- */
  function stamp() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  async function pruneAutoBackups() {
    // Only auto snapshots rotate; manual ones are kept forever.
    try {
      const files = (await davList(BACKUP_DIR))
        .filter((f) => f.name !== 'latest.json' && /^neotab-auto-/.test(f.name))
        .sort((a, b) => b.time - a.time);
      for (let i = AUTO_KEEP_LIMIT; i < files.length; i++) {
        await deleteFile(BACKUP_DIR + '/' + files[i].name);
      }
    } catch (e) {
      console.warn('[webdav] 清理过期备份失败', e);
    }
  }

  async function backup(silent, kind) {
    const isAuto = kind === 'auto';
    const cfg = getConfig();
    if (!cfg.url) {
      if (!silent) setStatus('请先配置 WebDAV 服务器地址', 'error');
      return false;
    }
    if (!(await requestHostPermission(cfg.url))) {
      if (!silent) setStatus('未授予访问 WebDAV 服务器的权限', 'error');
      return false;
    }
    if (!silent) setStatus('正在备份数据…');

    const payload = {
      _neotabWebdav: 1,
      _time: Date.now(),
      _version: 2,
      _kind: isAuto ? 'auto' : 'manual',
      data: await collectData()
    };
    const body = JSON.stringify(payload);
    try {
      const name = (isAuto ? 'neotab-auto-' : 'neotab-') + stamp() + '.json';
      await putWithRetry(BACKUP_DIR + '/' + name, body);
      await putWithRetry(BACKUP_DIR + '/latest.json', body);
      await pruneAutoBackups();
      // Advance the watermark so our own upload is not pulled back as newer.
      cfg.lastSync = payload._time;
      saveConfig(cfg);
      if (!silent) {
        setStatus('备份成功：' + name, 'success');
        await refreshList();
      }
      return true;
    } catch (e) {
      console.error('[webdav] 备份失败', e);
      if (!silent) setStatus('备份失败：' + e.message, 'error');
      return false;
    }
  }

  /* ---- restore ------------------------------------------------------------- */
  async function restore(name) {
    const cfg = getConfig();
    if (!cfg.url) return;
    if (!(await requestHostPermission(cfg.url))) {
      return setStatus('未授予访问 WebDAV 服务器的权限', 'error');
    }
    if (!confirm('此操作将会覆盖本地数据，是否继续？')) return;
    setStatus('正在恢复数据…');
    try {
      const obj = JSON.parse(await getFile(BACKUP_DIR + '/' + name));
      const data = obj && obj._neotabWebdav ? obj.data : obj;
      // A cheap sanity check only; the state layer does the full decode.
      const looksLikeBackup = !!data && typeof data === 'object' &&
        data.format === 'neotab' && Array.isArray(data.desks);
      if (!looksLikeBackup) throw new Error('数据格式可能不正确');

      suppressPush(SILENCE_AFTER_PULL);
      applyData(data);
      // Move the watermark to this snapshot so startup does not apply it again.
      const next = getConfig();
      next.lastSync = obj._neotabWebdav ? (obj._time || Date.now()) : Date.now();
      saveConfig(next);
      setStatus('恢复成功，即将刷新页面…', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      console.error('[webdav] 恢复失败', e);
      setStatus('恢复失败：' + e.message, 'error');
    }
  }

  /* ---- pull from the cloud -------------------------------------------------- */
  function showToast(msg, type) {
    NT.util.toast(msg, type === 'close' || type === 'error');
  }

  async function fetchLatest() {
    const url = joinUrl(getConfig().url, BACKUP_DIR + '/latest.json');
    const res = await sendDav(url, 'GET');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(explainFailure(res, url));
    const obj = JSON.parse(await res.text());
    if (!obj || !obj._neotabWebdav || !obj.data) throw new Error('数据格式不正确');
    return { time: obj._time || 0, data: obj.data };
  }

  async function syncCheck(manual) {
    const cfg = getConfig();
    if (!cfg.url) return false;
    if (!(await requestHostPermission(cfg.url))) {
      if (manual) showToast('未授予访问 WebDAV 服务器的权限', 'close');
      return false;
    }
    try {
      const latest = await fetchLatest();
      if (!latest) {
        if (manual) showToast('云端暂无备份', 'close');
        return false;
      }
      if (latest.time <= (cfg.lastSync || 0)) {
        if (manual) showToast('云端无新备份', 'close');
        return false;
      }
      // Cloud copy is newer (possibly from another device): apply it locally.
      suppressPush(SILENCE_AFTER_PULL);
      applyData(latest.data);
      cfg.lastSync = latest.time;
      saveConfig(cfg);
      showToast('同步成功', 'check');
      return true;
    } catch (e) {
      console.warn('[webdav] 同步检查失败', e);
      if (manual) showToast('同步失败：' + (e.message || '未知错误'), 'close');
      return false;
    }
  }

  /* ---- debounced push ------------------------------------------------------- */
  let pushTimer = null;
  let silenceUntil = 0;

  function suppressPush(ms) {
    // Writes caused by applying cloud data must not be pushed straight back.
    silenceUntil = Date.now() + ms;
    clearTimeout(pushTimer);
  }

  function schedulePush() {
    if (!getConfig().url) return;
    if (Date.now() < silenceUntil) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      if (Date.now() < silenceUntil) return;
      backup(true, 'auto').then((ok) => {
        if (!ok) console.warn('[webdav] 实时同步失败，将在下次变更时重试');
      });
    }, PUSH_DELAY);
  }

  function watchState() {
    NT.bus.on('state:change', schedulePush);
  }

  /* ---- settings panel ------------------------------------------------------- */
  let dialogNode = null;
  let statusTimer = null;

  function setStatus(msg, type) {
    const el = dialogNode && dialogNode.style.display !== 'none'
      ? dialogNode.querySelector('.wd-status')
      : null;
    if (!el) {
      // Panel not open (e.g. backup triggered from elsewhere): fall back to a toast.
      if (msg && (type === 'success' || type === 'error')) {
        showToast(msg, type === 'success' ? 'check' : 'close');
      } else {
        console.log('[webdav]', msg);
      }
      return;
    }
    el.textContent = msg || '';
    el.className = 'wd-status' + (type ? ' ' + type : '');
    clearTimeout(statusTimer);
    if (msg) {
      statusTimer = setTimeout(() => {
        el.textContent = '';
        el.className = 'wd-status';
      }, STATUS_LIFETIME);
    }
  }

  function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => map[c]);
  }

  function ensureDialog() {
    if (dialogNode) return;
    const wrap = document.createElement('div');
    wrap.className = 'neotab-webdav-mask';
    wrap.innerHTML = `
      <div class="neotab-webdav-dialog">
        <div class="wd-title">WebDAV<span class="wd-close" title="关闭">×</span></div>
        <div class="wd-section">
          <label>服务器地址</label>
          <input class="wd-url" type="text" placeholder="https://dav.jianguoyun.com/dav/">
          <div class="wd-row">
            <div class="wd-col"><label>用户名</label><input class="wd-user" type="text" autocomplete="off"></div>
            <div class="wd-col"><label>密码（应用密码）</label><input class="wd-pass" type="password" autocomplete="new-password"></div>
          </div>
          <div class="wd-row">
            <button class="wd-btn wd-save">保存配置</button>
            <button class="wd-btn wd-test">测试连接</button>
          </div>
        </div>
        <div class="wd-section wd-actions">
          <button class="wd-btn wd-primary wd-backup">备份到云端</button>
        </div>
        <div class="wd-section">
          <div class="wd-list-head">云端备份（自动备份保留 ${AUTO_KEEP_LIMIT} 份，手动备份不清理）<button class="wd-btn wd-sm wd-refresh">刷新</button></div>
          <div class="wd-list"><div class="wd-empty">尚未加载</div></div>
        </div>
        <div class="wd-status"></div>
      </div>`;
    document.body.appendChild(wrap);
    dialogNode = wrap;

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.classList.contains('wd-close')) close();
    });

    const q = (sel) => dialogNode.querySelector(sel);
    const readForm = () => {
      const url = q('.wd-url').value.trim();
      if (!/^https?:\/\//.test(url)) {
        setStatus('服务器地址需以 http(s):// 开头', 'error');
        return null;
      }
      const cfg = getConfig();
      cfg.url = url;
      cfg.username = q('.wd-user').value.trim();
      cfg.password = q('.wd-pass').value;
      saveConfig(cfg);
      return cfg;
    };

    q('.wd-save').addEventListener('click', async () => {
      const cfg = readForm();
      if (!cfg) return;
      setStatus('配置已保存', 'success');
      if (!(await requestHostPermission(cfg.url))) {
        setStatus('已保存，但未授予该站点访问权限，可能无法连接', 'error');
      }
      await refreshList();
    });

    q('.wd-test').addEventListener('click', async () => {
      const cfg = readForm();
      if (!cfg) return;
      if (!(await requestHostPermission(cfg.url))) return setStatus('未授予访问权限', 'error');
      setStatus('正在连接…');
      try {
        await ensureDirectory();
        setStatus('连接成功', 'success');
        await refreshList();
      } catch (e) {
        setStatus('连接失败：' + e.message, 'error');
      }
    });

    q('.wd-backup').addEventListener('click', () => backup(false, 'manual'));
    q('.wd-refresh').addEventListener('click', () => refreshList());

    q('.wd-list').addEventListener('click', (e) => {
      const name = e.target.getAttribute('data-name');
      if (!name) return;
      if (e.target.classList.contains('wd-restore')) {
        restore(name);
      } else if (e.target.classList.contains('wd-del')) {
        if (!confirm('此操作将会删除云端备份数据 ' + name + '，是否继续？')) return;
        deleteFile(BACKUP_DIR + '/' + name).then(() => {
          setStatus('删除成功', 'success');
          refreshList();
        }).catch((err) => setStatus('删除失败：' + err.message, 'error'));
      }
    });
  }

  async function refreshList() {
    if (!dialogNode) return;
    const listEl = dialogNode.querySelector('.wd-list');
    if (!getConfig().url) {
      listEl.innerHTML = '<div class="wd-empty">请先配置服务器地址</div>';
      return;
    }
    listEl.innerHTML = '<div class="wd-empty">加载中…</div>';
    try {
      const files = (await davList(BACKUP_DIR)).sort((a, b) => b.time - a.time);
      if (!files.length) {
        listEl.innerHTML = '<div class="wd-empty">暂无云端备份</div>';
        return;
      }
      listEl.innerHTML = files.map((f) => {
        const t = f.time ? new Date(f.time).toLocaleString('zh-CN', { hour12: false }) : '-';
        return '<div class="wd-item"><span class="wd-item-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
          '<span class="wd-item-time">' + escapeHtml(t) + '</span>' +
          '<span class="wd-restore" data-name="' + escapeHtml(f.name) + '">恢复</span>' +
          '<span class="wd-del" data-name="' + escapeHtml(f.name) + '">删除</span></div>';
      }).join('');
    } catch (e) {
      listEl.innerHTML = '<div class="wd-empty">读取失败：' + escapeHtml(e.message) + '</div>';
    }
  }

  function fillForm() {
    const cfg = getConfig();
    dialogNode.querySelector('.wd-url').value = cfg.url || '';
    dialogNode.querySelector('.wd-user').value = cfg.username || '';
    dialogNode.querySelector('.wd-pass').value = cfg.password || '';
  }

  function open() {
    ensureDialog();
    dialogNode.classList.remove('neotab-webdav-inline');
    if (dialogNode.parentNode !== document.body) document.body.appendChild(dialogNode);
    fillForm();
    dialogNode.style.display = 'flex';
    setStatus('');
    refreshList();
  }

  function close() {
    if (dialogNode) dialogNode.style.display = 'none';
  }

  // Embedded mode: move the same dialog into the settings page host, without
  // the backdrop so it follows the page layout.
  function openInline(host) {
    if (!host) return open();
    ensureDialog();
    fillForm();
    dialogNode.classList.add('neotab-webdav-inline');
    dialogNode.style.display = 'block';
    host.appendChild(dialogNode);
    setStatus('');
    refreshList();
  }

  function closeInline() {
    if (!dialogNode) return;
    dialogNode.classList.remove('neotab-webdav-inline');
    dialogNode.style.display = 'none';
    if (dialogNode.parentNode !== document.body) document.body.appendChild(dialogNode);
  }

  /* ---- panel styles --------------------------------------------------------- */
  const STYLE_RULES = [
    // Backdrop and dialog shell: transparent + blur, like the rest of the UI.
    '.neotab-webdav-mask{display:none;position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);align-items:center;justify-content:center}',
    '.neotab-webdav-dialog{width:520px;max-width:92vw;max-height:86vh;overflow:auto;background:transparent;color:var(--text);border:1px solid var(--stroke);border-radius:var(--radius-lg);padding:20px 22px;font-size:13px;box-shadow:var(--shadow),var(--inset);-webkit-backdrop-filter:var(--blur-panel);backdrop-filter:var(--blur-panel);font-family:inherit}',
    '.wd-title{font-size:16px;font-weight:600;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}',
    '.wd-close{cursor:pointer;font-size:20px;line-height:1;opacity:.6}.wd-close:hover{opacity:1}',
    '.wd-section{margin-bottom:16px}',
    '.neotab-webdav-dialog label{display:block;margin:8px 0 4px;opacity:.85}',
    '.neotab-webdav-dialog input[type=text],.neotab-webdav-dialog input[type=password],.wd-auto-hours{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--stroke);border-radius:6px;background:transparent;color:inherit;font-size:13px;outline:none}',
    '.neotab-webdav-dialog input:focus,.wd-auto-hours:focus{border-color:#fff}',
    '.wd-row{display:flex;gap:10px}.wd-col{flex:1}',
    '.wd-btn{height:30px;padding:0 14px;border:1px solid var(--stroke);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:13px;white-space:nowrap;flex-shrink:0}',
    '.wd-btn:hover{border-color:rgba(255,255,255,.6);color:#fff}',
    // Primary action stays a ghost button so it does not dominate the panel.
    '.wd-primary{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.35);color:#fff}.wd-primary:hover{background:rgba(255,255,255,.24);color:#fff}',
    '.wd-actions{display:flex;align-items:center;gap:12px}',
    '.wd-auto{display:flex;align-items:center;gap:5px;margin:0 !important}',
    '.wd-auto input{width:auto}',
    '.wd-auto-hours{width:auto !important}',
    '.wd-list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;opacity:.85}',
    '.wd-sm{height:24px;padding:0 10px;font-size:12px}',
    '.wd-list{border:1px solid var(--stroke-soft);border-radius:8px;min-height:40px;max-height:220px;overflow:auto}',
    '.wd-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--stroke-soft)}',
    '.wd-item:last-child{border-bottom:none}',
    '.wd-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wd-item-time{opacity:.55;font-size:12px}',
    '.wd-restore,.wd-del{cursor:pointer;color:#fff;font-size:12px;flex-shrink:0}',
    '.wd-del{color:var(--danger)}',
    '.wd-empty{padding:12px;text-align:center;opacity:.55}',
    '.wd-status{min-height:20px;margin-top:4px;font-size:12px}',
    '.wd-status.success{color:#9be08a}.wd-status.error{color:var(--danger)}',
    // Embedded mode drops the backdrop and the close affordance.
    '.neotab-webdav-mask.neotab-webdav-inline{position:static;inset:auto;display:block;background:none;z-index:auto}',
    '.neotab-webdav-inline .neotab-webdav-dialog{width:100%;max-width:none;max-height:none;box-shadow:none;padding:16px 18px}',
    '.neotab-webdav-inline .wd-close{display:none}',
    // Settings-page host: align the panel with the other settings rows. Only
    // rules scoped to .webdav-sync-panel apply here; the popup keeps its own.
    '.webdav-sync-panel{display:flex;flex-direction:column;gap:12px}',
    '.webdav-sync-panel .neotab-webdav-dialog{display:flex;flex-direction:column;gap:12px;padding:0;background:transparent;color:inherit;border:none;box-shadow:none;max-height:none;overflow:visible}',
    '.webdav-sync-panel .wd-title{display:block;margin:2px 0 0;font-size:14px;font-weight:600;line-height:24px;color:var(--text)}',
    '.webdav-sync-panel .wd-section{margin:0;padding:12px 16px;background:transparent;border:1px solid var(--stroke-soft);-webkit-backdrop-filter:blur(32px) saturate(170%);backdrop-filter:blur(32px) saturate(170%);border-radius:12px}',
    '.webdav-sync-panel .wd-section.wd-actions{padding:0;background:transparent;border:none}',
    '.webdav-sync-panel .wd-section.wd-actions .wd-btn{flex:1;height:34px}',
    // Labels sit on the wallpaper, so they need solid light text rather than
    // a translucent one that disappears on pale backgrounds.
    '.webdav-sync-panel .wd-section label{margin:8px 0 6px;opacity:1;color:rgba(255,255,255,.85)}',
    '.webdav-sync-panel .wd-section>label:first-child{margin-top:4px}',
    '.webdav-sync-panel .wd-row{gap:12px}',
    '.webdav-sync-panel .wd-row+.wd-row{margin-top:12px}',
    '.webdav-sync-panel .wd-list-head{gap:10px;opacity:1}',
    '.webdav-sync-panel a.link{color:#fff !important}',
    '.webdav-sync-panel .wd-list{border-color:var(--stroke-soft)}',
    '.webdav-sync-panel .wd-btn{border-color:var(--stroke)}',
    '.webdav-sync-panel .wd-btn:hover{border-color:rgba(255,255,255,.6);color:var(--text)}',
    '.webdav-sync-panel .wd-primary{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.35);color:#fff}',
    '.webdav-sync-panel .wd-primary:hover{background:rgba(255,255,255,.24);border-color:rgba(255,255,255,.45);color:#fff;filter:none}',
    '.webdav-sync-panel input[type=text],.webdav-sync-panel input[type=password]{border-color:var(--stroke)}',
    '.webdav-sync-panel input:focus{border-color:#fff}',
    '.webdav-sync-panel .wd-item{padding:8px 12px}',
    '.webdav-sync-panel .wd-item-time{opacity:.8}',
    '.webdav-sync-panel .wd-empty{opacity:.8}',
    '.webdav-sync-panel .wd-restore{color:#fff}',
    '.webdav-sync-panel .wd-status{margin:8px 0 0}',
    // Narrow viewports: stack the credential columns, keep buttons on one line.
    '@media (max-width:560px){.webdav-sync-panel .wd-row{flex-wrap:wrap}.webdav-sync-panel .wd-col{flex:1 1 100%}',
    '.neotab-webdav-inline .neotab-webdav-dialog{padding:0}.webdav-sync-panel .wd-list{max-height:180px}}'
  ];
  const style = document.createElement('style');
  style.textContent = STYLE_RULES.join('');
  document.documentElement.appendChild(style);

  /* ---- public surface ------------------------------------------------------- */
  const api = {
    open: open, close: close, openInline: openInline, closeInline: closeInline,
    backup: backup, restore: restore,
    syncCheck: syncCheck, fetchLatest: fetchLatest, refreshList: refreshList,
    getConfig: getConfig, saveConfig: saveConfig, collectData: collectData,
    schedulePush: schedulePush, davList: davList, DIR: BACKUP_DIR, KEEP: AUTO_KEEP_LIMIT
  };
  window.__neotabWebdav = api;
  NT.webdav = api;

  /* ---- startup -------------------------------------------------------------- */
  // Push on every state change; pull once at startup, but only after the state
  // has loaded so cloud data cannot be overwritten by initial defaults.
  watchState();
  const boot = () => { syncCheck(true); };
  if (document.body && document.body.dataset.ready === '1') boot();
  else NT.bus.on('ready', boot);
})();
