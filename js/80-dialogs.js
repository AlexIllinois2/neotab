/* NeoTab — dialogs, context menus, folder popup and bookmark import. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;

  let dialogLayer, folderLayer, menu;

  /* ---- 文件夹弹层内长按拖动排序 ----------------------------------------------
     与桌面磁贴一致的交互：按住 500ms 抬起，移动时本体 transform 跟随手指，
     实时插到最近兄弟磁贴前/后（按指针在其中心点左右半边），松手按 DOM 顺序
     回写 folder.children。弹层网格是均匀 auto-fill 网格且无让位动画，
     兄弟矩形即最终位置，直接用中心点最近邻即可。 */
  let fdCtx = null;        // 当前弹层 { grid, folder, press }
  let fdClickGuard = false; // 松手后吞掉紧跟的 click，防止拖完顺手打开链接

  function fdEndPress() {
    const ctx = fdCtx;
    if (!ctx || !ctx.press) return;
    const p = ctx.press;
    clearTimeout(p.timer);
    ctx.press = null;
    if (!p.armed) return;
    p.item.classList.remove('is-lifted');
    p.item.style.transform = '';
    p.item.style.zIndex = '';
    if (p.dragging) {
      const order = Array.prototype.map.call(ctx.grid.querySelectorAll('.folder-item'),
        function (n) { return n.dataset.childId; })
        .map(function (id) { return ctx.folder.children.find(function (c) { return c.id === id; }); })
        .filter(Boolean);
      if (order.length === ctx.folder.children.length) {
        ctx.folder.children = order;
        // 只重绘桌面网格；弹层已按 DOM 实时重排，保持现状即可。
        NT.state.changed({ grid: true });
      }
    }
    fdClickGuard = true;
    setTimeout(function () { fdClickGuard = false; }, 0); // click 在此之前同步派发
  }

  /* 与桌面 stableRect 同款：剔除 transform 后的基础位置。弹层内磁贴在
     FLIP 过渡飞行中矩形是临时的，直接用会让最近邻判定振荡。 */
  function fdStableRect(n) {
    const b = n.getBoundingClientRect();
    let tx = 0, ty = 0;
    const m = getComputedStyle(n).transform;
    if (m && m.indexOf('matrix') === 0) {
      const p = m.slice(m.indexOf('(') + 1, -1).split(',').map(parseFloat);
      tx = p.length >= 16 ? p[12] : p[4];
      ty = p.length >= 16 ? p[13] : p[5];
    }
    return { left: b.left - tx, top: b.top - ty, width: b.width, height: b.height };
  }

  /* 兄弟磁贴让位的 FLIP 动画：先记位置，重排后从旧位滑到新位，不再瞬移。
     被拖项不参与（它由调用方重锚 transform）。token 防止连续快速重排时
     上一轮的清理定时器把这一轮的过渡中途打断。 */
  function fdFlip(grid, dragged, mutate) {
    const items = Array.prototype.filter.call(grid.querySelectorAll('.folder-item'),
      function (n) { return n !== dragged; });
    const before = items.map(function (n) { return [n, fdStableRect(n)]; });
    mutate();
    before.forEach(function (pair) {
      const n = pair[0], b = pair[1];
      const a = fdStableRect(n);
      const dx = b.left - a.left, dy = b.top - a.top;
      if (!dx && !dy) return;
      n.style.transition = 'none';
      n.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      void n.offsetWidth; // 强制回流，确保从旧位起步
      n.style.transition = 'transform 180ms ease';
      n.style.transform = '';
      const token = n._fdFlip = (n._fdFlip || 0) + 1;
      setTimeout(function () { if (n._fdFlip === token) n.style.transition = ''; }, 200);
    });
  }

  function fdOnMove(e) {
    const ctx = fdCtx;
    if (!ctx || !ctx.press) return;
    const p = ctx.press;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.armed) {
      if (dx * dx + dy * dy > 64) { clearTimeout(p.timer); ctx.press = null; } // 移动即取消长按
      return;
    }
    p.dragging = true;
    p.item.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    e.preventDefault();
    let best = null, bestD = Infinity, bestCx = 0;
    Array.prototype.forEach.call(ctx.grid.querySelectorAll('.folder-item'), function (n) {
      if (n === p.item) return;
      const r = fdStableRect(n);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = (cx - e.clientX) * (cx - e.clientX) + (cy - e.clientY) * (cy - e.clientY);
      if (d < bestD) { bestD = d; best = n; bestCx = cx; }
    });
    if (!best) return;
    const before = e.clientX > bestCx ? best.nextSibling : best;
    if (before === p.item || p.item.nextSibling === before) return;
    // 重排会改变被拖项的基座位置：FLIP 让位的同时重锚，保持视觉位置连续。
    const oldBase = fdStableRect(p.item);
    fdFlip(ctx.grid, p.item, function () { ctx.grid.insertBefore(p.item, before); });
    const newBase = fdStableRect(p.item);
    const shiftX = newBase.left - oldBase.left, shiftY = newBase.top - oldBase.top;
    if (shiftX || shiftY) {
      p.x += shiftX; p.y += shiftY;
      p.item.style.transform = 'translate(' + (e.clientX - p.x) + 'px,' + (e.clientY - p.y) + 'px)';
    }
  }

  function fdOnDown(e) {
    const ctx = fdCtx;
    if (!ctx || (e.button !== undefined && e.button !== 0)) return;
    const item = e.target.closest('.folder-item');
    if (!item) return;
    const p = { item: item, x: e.clientX, y: e.clientY, timer: null, armed: false, dragging: false };
    ctx.press = p;
    p.timer = setTimeout(function () {
      if (ctx.press !== p) return;
      p.armed = true;
      item.classList.add('is-lifted');
      item.style.zIndex = '6';
    }, 500);
  }

  function closeDialog() { dialogLayer.hidden = true; dialogLayer.textContent = ''; }
  function closeFolder() { folderLayer.hidden = true; folderLayer.textContent = ''; fdCtx = null; closeMenu(); }

  function showDialog(box) {
    closeMenu();
    closeFolder();
    dialogLayer.textContent = '';
    dialogLayer.appendChild(box);
    dialogLayer.hidden = false;
    const first = U.$('input, select, textarea', box);
    if (first) first.focus();
  }

  /* Generic form: fields = [{ key, label, value, type, options, placeholder }] */
  function formDialog(options) {
    const box = U.el('div', { class: 'dialog' });
    box.appendChild(U.el('h3', { text: options.title || '' }));
    const inputs = {};
    (options.fields || []).forEach(function (field) {
      box.appendChild(U.el('label', { class: 'field-label', text: field.label }));
      let input;
      if (field.type === 'select') {
        input = U.el('select', { class: 'full-input' });
        (field.options || []).forEach(function (opt) {
          input.appendChild(U.el('option', { value: opt.value, text: opt.label }));
        });
        input.value = field.value;
      } else if (field.type === 'icon') {
        input = U.el('input', { class: 'full-input', type: 'text', placeholder: field.placeholder || '留空则自动解析网站图标' });
        input.value = field.value || '';
        const upload = U.el('button', { class: 'text-btn', type: 'button', text: '上传本地图标…' });
        upload.addEventListener('click', function () {
          const fileInput = U.$('#iconFile');
          fileInput.value = '';
          fileInput.onchange = function () {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            U.readDataUrl(file).then(function (data) { input.value = data; U.toast('图标已读入，点击保存生效'); });
          };
          fileInput.click();
        });
        box.appendChild(input);
        box.appendChild(upload);
        inputs[field.key] = input;
        return;
      } else {
        input = U.el('input', { class: 'full-input', type: field.type || 'text', placeholder: field.placeholder || '' });
        input.value = field.value || '';
      }
      box.appendChild(input);
      inputs[field.key] = input;
    });
    if (options.note) box.appendChild(U.el('p', { class: 'dialog-note', text: options.note }));
    if (options.action) {
      box.appendChild(U.el('button', { class: 'text-btn dialog-action-btn', type: 'button', text: options.action.label, onclick: options.action.onclick }));
    }
    const actions = U.el('div', { class: 'dialog-actions' });
    actions.appendChild(U.el('button', { class: 'secondary-btn', type: 'button', text: '取消', onclick: closeDialog }));
    actions.appendChild(U.el('button', {
      class: 'primary-btn', type: 'button', text: options.submitText || '保存',
      onclick: function () {
        const values = {};
        Object.keys(inputs).forEach(function (key) { values[key] = inputs[key].value.trim(); });
        if (options.onSubmit(values) !== false) closeDialog();
      }
    }));
    box.appendChild(actions);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        U.$('.dialog-actions .primary-btn', box).click();
      }
    });
    showDialog(box);
  }

  function prompt(title, label, value, onSubmit) {
    formDialog({
      title: title, fields: [{ key: 'value', label: label, value: value || '' }],
      onSubmit: function (values) {
        if (!values.value) { U.toast('内容不能为空', true); return false; }
        onSubmit(values.value);
      }
    });
  }

  function confirm(title, message, onConfirm) {
    const box = U.el('div', { class: 'dialog' }, [
      U.el('h3', { text: title }),
      U.el('p', { class: 'dialog-note', text: message })
    ]);
    const actions = U.el('div', { class: 'dialog-actions' });
    actions.appendChild(U.el('button', { class: 'secondary-btn', type: 'button', text: '取消', onclick: closeDialog }));
    actions.appendChild(U.el('button', {
      class: 'danger-btn', type: 'button', text: '确定',
      onclick: function () { closeDialog(); onConfirm(); }
    }));
    box.appendChild(actions);
    showDialog(box);
  }

  /* ---- context menu -------------------------------------------------------- */
  function closeMenu() { if (menu) { menu.hidden = true; menu.textContent = ''; } }

  function contextMenu(x, y, items) {
    // 不关文件夹弹层：弹层内磁贴右键也要弹菜单（菜单 z-index 在弹层之上）；
    // 弹层打开时桌面被遮挡，桌面入口本就触发不到 closeFolder。
    closeDialog();
    menu.textContent = '';
    items.forEach(function (entry) {
      if (entry === '-') { menu.appendChild(U.el('div', { class: 'menu-sep' })); return; }
      if (entry.label && !entry.action) { menu.appendChild(U.el('div', { class: 'menu-label', text: entry.label })); return; }
      const node = U.el('button', {
        type: 'button', class: entry.danger ? 'is-danger' : '',
        text: (entry.checked ? '● ' : '') + entry.label,
        onclick: function () { closeMenu(); entry.action(); }
      });
      menu.appendChild(node);
    });
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, global.innerWidth - rect.width - 10) + 'px';
    menu.style.top = Math.min(y, global.innerHeight - rect.height - 10) + 'px';
  }

  /* ---- add / edit a tile --------------------------------------------------- */
  const SIZES = [
    { value: '1x1', label: '标准 1×1' },
    { value: '2x1', label: '宽磁贴 2×1' },
    { value: '2x2', label: '大磁贴 2×2' }
  ];

  function editTile(itemId, folderId) {
    const found = itemId ? NT.state.findItem(itemId) : null;
    const item = found && found.item;
    const isFolder = item && item.type === 'folder';
    const fields = [{ key: 'title', label: '名称', value: item ? item.title : '', placeholder: '例如：GitHub' }];
    if (!isFolder && (!item || item.type === 'link')) {
      fields.push({ key: 'url', label: '网址', value: item ? item.url : '', placeholder: 'https://example.com' });
      fields.push({ key: 'icon', label: '图标地址', type: 'icon', value: item ? item.icon : '' });
      fields.push({ key: 'letter', label: '文字图标（网址图标不可用时显示）', value: item ? item.letter : '', placeholder: '留空自动生成' });
      fields.push({ key: 'color', label: '背景色（如 #3b82f6，留空则透明）', value: item ? item.color : '' });
    }
    fields.push({ key: 'size', label: '尺寸', type: 'select', options: SIZES, value: item ? item.size : '1x1' });
    formDialog({
      title: item ? (isFolder ? '编辑文件夹' : '编辑图标') : '添加图标',
      fields: fields,
      note: '图标与网址只保存在本机；留空图标时自动解析网站 favicon（可在「设置 → 通用」关闭），仍不可用则显示文字图标。',
      action: !item && !folderId ? { label: '从书签批量导入…', onclick: function () { importBookmarks(); } } : null,
      onSubmit: function (values) {
        if (!values.title) { U.toast('请填写名称', true); return false; }
        const patch = { title: values.title, size: values.size || '1x1' };
        if (item && item.type === 'link') {
          if (!values.url) { U.toast('请填写网址', true); return false; }
          NT.icons.forget(values.url);
          Object.assign(patch, {
            url: U.normalizeUrl(values.url), icon: values.icon,
            letter: values.letter, color: values.color
          });
        }
        if (item) { Object.assign(item, patch); NT.state.changed({ grid: true }); }
        else if (folderId) {
          if (!values.url) { U.toast('请填写网址', true); return false; }
          const parent = NT.state.findItem(folderId);
          if (!parent || parent.item.type !== 'folder') return false;
          parent.item.children.push(Object.assign({ id: U.uid(), type: 'link' }, patch, {
            url: U.normalizeUrl(values.url || ''), icon: values.icon || '',
            letter: values.letter || '', color: values.color || ''
          }));
          NT.state.changed({ grid: true });
          openFolder(folderId);
        } else {
          NT.state.addItem(Object.assign({ id: U.uid(), type: 'link' }, patch, {
            url: U.normalizeUrl(values.url || ''), icon: values.icon || '',
            letter: values.letter || '', color: values.color || ''
          }));
        }
      }
    });
  }

  function addFolder() {
    prompt('新建文件夹', '文件夹名称', '新文件夹', function (name) {
      NT.state.addItem({ id: U.uid(), type: 'folder', title: name, size: '1x1', children: [] });
    });
  }

  function addWidget(kind) {
    NT.state.addItem({ id: U.uid(), type: 'widget', widget: kind, title: kind === 'todo' ? '待办' : '日历', size: '2x2' });
  }

  /* ---- private folder --------------------------------------------------------
     SHA-256(`${salt}:${password}`)（WebCrypto）+ 16 字节随机 salt（hex），
     只落 secret/lockSalt/lockHash，绝不存明文；每个私密文件夹独立密码。
     设密走表单弹窗；开夹/取消私密前先验密，错误 toast「密码错误」。 */
  function toHex(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function makeSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
  }
  function hashPassword(salt, password) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + password)).then(toHex);
  }
  function isFolderLocked(item) {
    return !!(item && item.type === 'folder' && item.secret && item.lockHash && item.lockSalt);
  }
  function setPasswordDialog() {
    return new Promise(function (resolve) {
      formDialog({
        title: '设为私密文件夹',
        fields: [{ key: 'pwd', label: '访问密码（每个文件夹独立，密码不可找回）', type: 'password', placeholder: '请输入密码' }],
        onSubmit: function (values) {
          if (!values.pwd) { U.toast('密码不能为空', true); return false; }
          const salt = makeSalt();
          hashPassword(salt, values.pwd).then(function (hash) { resolve({ salt: salt, hash: hash }); });
        }
      });
    });
  }
  function verifyPasswordDialog(item, title) {
    if (!isFolderLocked(item)) return Promise.resolve(true);
    return new Promise(function (resolve) {
      formDialog({
        title: title || '私密文件夹',
        fields: [{ key: 'pwd', label: '请输入密码以打开该文件夹', type: 'password', placeholder: '请输入密码' }],
        onSubmit: function (values) {
          hashPassword(item.lockSalt, values.pwd || '').then(function (hash) {
            if (hash === item.lockHash) resolve(true);
            else { U.toast('密码错误', true); resolve(false); }
          });
        }
      });
    });
  }
  /* 点击/查找打开文件夹的唯一入口：锁定文件夹先验密。 */
  function openFolderGate(folderId) {
    const found = NT.state.findItem(folderId);
    if (!found || found.item.type !== 'folder') return;
    verifyPasswordDialog(found.item).then(function (ok) { if (ok) openFolder(folderId); });
  }

  /* ---- folder popup -------------------------------------------------------- */
  function openFolder(folderId) {
    const found = NT.state.findItem(folderId);
    if (!found || found.item.type !== 'folder') return;
    const folder = found.item;
    closeDialog(); closeMenu();
    const box = U.el('div', { class: 'dialog folder-dialog' });
    box.appendChild(U.el('h3', { text: folder.title }));
    const grid = U.el('div', { class: 'folder-grid' });
    if (!folder.children.length) grid.appendChild(U.el('div', { class: 'folder-empty', text: '文件夹是空的，把桌面图标拖进来即可添加' }));
    folder.children.forEach(function (child) {
      const wrap = U.el('div', { class: 'folder-item' });
      const iconBox = U.el('div', { class: 'tile-icon is-letter' });
      const letter = U.el('span', { class: 'tile-letter', text: child.letter || U.letter(child.title, child.url) });
      letter.style.background = child.color && child.color !== 'transparent' ? child.color : 'transparent';
      iconBox.appendChild(letter);
      if (child.type !== 'action') {
        const img = U.el('img', { alt: '', draggable: 'false' });
        iconBox.appendChild(img);
        NT.icons.apply(img, iconBox, child);
      }
      iconBox.addEventListener('click', function () {
        if (fdClickGuard) return; // 长按/拖动松手后的那次 click，吞掉
        closeFolder(); U.openUrl(child.url, NT.state.data.config.iconBlank);
      });
      iconBox.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        if (fdCtx && fdCtx.press) return; // 长按拖动进行中，不弹菜单
        contextMenu(e.clientX, e.clientY, [
          { label: '打开', action: function () { closeFolder(); U.openUrl(child.url, NT.state.data.config.iconBlank); } },
          { label: '从文件夹移除', danger: true, action: function () {
            const i = folder.children.indexOf(child);
            if (i >= 0) folder.children.splice(i, 1);
            NT.state.changed({ grid: true });
            openFolder(folderId);
          } }
        ]);
      });
      wrap.dataset.childId = child.id;
      wrap.appendChild(iconBox);
      wrap.appendChild(U.el('span', { class: 'tile-title', text: child.title }));
      grid.appendChild(wrap);
    });
    box.appendChild(grid);
    folderLayer.textContent = '';
    folderLayer.appendChild(box);
    folderLayer.hidden = false;
    fdCtx = { grid: grid, folder: folder, press: null };
  }

  /* ---- menus --------------------------------------------------------------- */
  function tileMenu(x, y, id) {
    const found = NT.state.findItem(id);
    if (!found) return;
    const item = found.item;
    const items = [];
    if (item.type === 'folder') {
      items.push({ label: '重命名', action: function () { editTile(id); } });
      items.push({ label: '添加图标到文件夹', action: function () { editTile(null, id); } });
      if (item.secret) {
        items.push({ label: '取消私密文件夹', action: function () {
          verifyPasswordDialog(item, '取消私密文件夹').then(function (ok) {
            if (!ok) return;
            delete item.secret; delete item.lockSalt; delete item.lockHash;
            NT.state.changed({ grid: true });
            U.toast('已取消私密文件夹');
          });
        } });
      } else {
        items.push({ label: '设为私密文件夹', action: function () {
          setPasswordDialog().then(function (payload) {
            if (!payload) return;
            item.secret = true; item.lockSalt = payload.salt; item.lockHash = payload.hash;
            NT.state.changed({ grid: true });
            U.toast('已设为私密文件夹');
          });
        } });
      }
    } else if (item.type === 'link') {
      items.push({ label: '打开', action: function () { U.openUrl(item.url, NT.state.data.config.iconBlank); } });
      items.push({ label: '编辑', action: function () { editTile(id); } });
      items.push({ label: '复制名称与网址', action: function () {
        if (navigator.clipboard) navigator.clipboard.writeText(item.title + ' ' + item.url).then(function () { U.toast('已复制'); }, function () {});
      } });
      items.push({ label: '重新解析网站图标', action: function () {
        NT.icons.forget(item.url);
        NT.state.changed({ grid: true });
        U.toast('正在重新解析图标');
      } });
    } else {
      items.push({ label: '重命名', action: function () {
        prompt('重命名小组件', '名称', item.title, function (name) { item.title = name; NT.state.changed({ grid: true }); });
      } });
    }
    items.push('-');
    items.push({ label: '尺寸', action: null });
    SIZES.forEach(function (size) {
      items.push({
        label: size.label, checked: (item.size || '1x1') === size.value,
        action: function () { item.size = size.value; NT.state.changed({ grid: true }); }
      });
    });
    items.push('-');
    items.push({ label: '删除', danger: true, action: function () {
      NT.dialogs.confirm('删除「' + item.title + '」', '该操作不可撤销。', function () { NT.state.removeItem(id); });
    } });
    contextMenu(x, y, items);
  }

  function deskMenu(x, y) {
    contextMenu(x, y, [
      { label: '添加图标', action: function () { editTile(); } },
      { label: '添加小组件', action: function () {
        // 二级菜单：点击项的 click 冒泡会立刻关闭刚打开的菜单，延后一帧再弹。
        setTimeout(function () {
          contextMenu(x, y, [
            { label: '日历小组件', action: function () { addWidget('calendar'); } },
            { label: '待办小组件', action: function () { addWidget('todo'); } }
          ]);
        }, 0);
      } },
      '-',
      { label: '新建桌面', action: function () {
        prompt('新建桌面', '桌面名称', '桌面 ' + (NT.state.data.desks.length + 1), function (name) { NT.state.addDesk(name); });
      } },
      { label: '更换壁纸', action: function () { NT.wallpaper.pickFile(); } },
      '-',
      { label: '设置', action: function () { NT.settings.open(); } }
    ]);
  }

  function deskItemMenu(x, y, deskId) {
    const d = NT.state.data.desks.find(function (item) { return item.id === deskId; });
    if (!d) return;
    contextMenu(x, y, [
      { label: '切换到此桌面', action: function () { NT.state.setActiveDesk(deskId); } },
      { label: '重命名', action: function () {
        prompt('重命名桌面', '桌面名称', d.name, function (name) {
          d.name = name; d.glyph = name.charAt(0); NT.state.changed({ desks: true });
        });
      } },
      { label: '上移', action: function () { NT.desks.reorder(deskId, neighbor(deskId, -1)); } },
      { label: '下移', action: function () { NT.desks.reorder(deskId, neighbor(deskId, 1)); } },
      '-',
      { label: '删除桌面', danger: true, action: function () {
        confirm('删除桌面「' + d.name + '」', '桌面内的图标也会一并删除，且无法撤销。', function () {
          if (!NT.state.removeDesk(deskId)) U.toast('至少保留一个桌面', true);
        });
      } }
    ]);
  }

  function neighbor(id, delta) {
    const desks = NT.state.data.desks;
    const index = desks.findIndex(function (d) { return d.id === id; });
    return desks[U.clamp(index + delta, 0, desks.length - 1)].id;
  }

  /* ---- bookmarks ----------------------------------------------------------- */
  function flattenBookmarks(nodes, out) {
    (nodes || []).forEach(function (node) {
      if (node.url && out.length < 80) out.push({ title: node.title || U.hostname(node.url), url: node.url });
      if (node.children) flattenBookmarks(node.children, out);
    });
    return out;
  }

  function importBookmarks() {
    if (!NT.isExtension || !chrome.bookmarks) {
      U.toast('书签导入仅在浏览器扩展环境可用', true);
      return;
    }
    const pending = new Promise(function (resolve, reject) {
      try {
        const result = chrome.bookmarks.getTree(function (nodes) { resolve(nodes); });
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      } catch (e) { reject(e); }
    });
    pending.then(function (tree) {
      const list = flattenBookmarks(tree, []);
      if (!list.length) { U.toast('没有找到书签', true); return; }
      confirm('从书签导入', '将新建「书签」桌面并导入 ' + list.length + ' 个链接。', function () {
        const d = NT.state.addDesk('书签');
        d.glyph = '书';
        list.forEach(function (entry) {
          d.items.push({ id: U.uid(), type: 'link', title: entry.title, url: entry.url, icon: '', color: '', letter: '', size: '1x1' });
        });
        NT.state.changed({ all: true });
        U.toast('已导入 ' + list.length + ' 个书签');
      });
    }).catch(function () { U.toast('读取书签失败', true); });
  }

  function init() {
    dialogLayer = U.$('#dialogLayer');
    folderLayer = U.$('#folderLayer');
    menu = U.$('#contextMenu');
    [dialogLayer, folderLayer].forEach(function (layer) {
      layer.addEventListener('click', function (e) { if (e.target === layer) { closeDialog(); closeFolder(); } });
    });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) closeMenu(); });
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest('.context-menu')) e.preventDefault();
    });
    global.addEventListener('resize', closeMenu);
    U.$('#stage').addEventListener('scroll', closeMenu);
    global.addEventListener('pointerdown', fdOnDown);
    global.addEventListener('pointermove', fdOnMove);
    global.addEventListener('pointerup', fdEndPress);
    global.addEventListener('pointercancel', fdEndPress);
  }

  NT.dialogs = {
    init: init, formDialog: formDialog, prompt: prompt, confirm: confirm,
    contextMenu: contextMenu, closeMenu: closeMenu, closeDialog: closeDialog, closeFolder: closeFolder,
    editTile: editTile, addFolder: addFolder, openFolder: openFolder, openFolderGate: openFolderGate,
    isFolderLocked: isFolderLocked,
    tileMenu: tileMenu, deskMenu: deskMenu, deskItemMenu: deskItemMenu,
    importBookmarks: importBookmarks
  };
})(window);
