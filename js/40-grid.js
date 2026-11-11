/* NeoTab — phone-desktop icon grid.
   Desktops are full-width horizontal pages (previous / current / next) so a
   swipe can follow the finger. Only the column count is configurable: tile
   size, radius, gap, label size and grid width derive from the viewport. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;
  let track, shell, currentGrid;

  /* ---- derived layout ------------------------------------------------------ */
  function layout() {
    if (!track || !shell) return { cols: 8, cell: 88, gap: 22, width: 1000 };
    const page = U.$('#deskTrack .desk-page.is-current') || U.$('#deskTrack .desk-page');
    const cs = page ? getComputedStyle(page) : null;
    const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 24;
    const avail = Math.max(220, shell.clientWidth - padX - 8);
    const narrow = global.innerWidth <= 560;
    const minCell = narrow ? 48 : 56;
    // Gap starts modest; any width left over is shared between columns below,
    // so the grid reaches both edges instead of floating in a narrow strip.
    const baseGap = U.clamp(avail * 0.02, narrow ? 10 : 16, narrow ? 20 : 28);
    const autoCols = U.clamp(Math.round(avail / (narrow ? 100 : 126)), narrow ? 3 : 5, 12);
    let cols = NT.state.data.config.cols || autoCols;
    // A user-chosen column count may never make tiles unreadably small.
    cols = Math.min(cols, Math.max(2, Math.floor((avail + baseGap) / (minCell + baseGap))));
    // Icon size is capped by the SHORT viewport edge (aesthetic ceiling), so a
    // wide screen gets large icons while a short landscape window stays sane.
    const shortEdge = Math.min(global.innerWidth, global.innerHeight);
    const maxCell = U.clamp(shortEdge * 0.14, narrow ? 58 : 68, narrow ? 76 : 108);
    const cell = Math.max(minCell, Math.min((avail - (cols - 1) * baseGap) / cols, maxCell));
    const spare = Math.max(0, avail - (cols * cell + (cols - 1) * baseGap));
    // With few columns the icons keep their aesthetic size and the extra room
    // becomes breathing space between them, like a phone home screen on a tablet.
    const gapCap = narrow ? 26 : U.clamp(cell * 0.9, 40, 100);
    const gap = baseGap + U.clamp(spare / Math.max(1, cols - 1), 0, gapCap);
    const gridWidth = Math.min(avail, cols * cell + (cols - 1) * gap);
    const nameSize = U.clamp(cell * 0.17, 11, 15);
    const rowH = cell + nameSize * 1.4 + 10;
    // Row spacing stays tied to the icon, not to the (possibly very wide)
    // column gap — otherwise a sparse grid pushes rows into the page dots.
    const rowGap = U.clamp(Math.min(gap * 0.72, cell * 0.30),
      narrow ? 10 : 14, narrow ? 24 : 30);
    const values = {
      '--cols': cols,
      '--gap': gap.toFixed(1) + 'px',
      '--row-gap': rowGap.toFixed(1) + 'px',
      '--cell': cell.toFixed(1) + 'px',
      '--row-h': rowH.toFixed(1) + 'px',
      '--name-size': nameSize.toFixed(1) + 'px',
      '--grid-width': gridWidth.toFixed(1) + 'px',
      '--tile-radius': Math.round(cell * 0.235) + 'px'
    };
    U.$$('#deskTrack .grid').forEach(function (g) {
      Object.keys(values).forEach(function (key) { g.style.setProperty(key, values[key]); });
    });
    return { cols: cols, cell: cell, gap: gap, width: gridWidth };
  }

  /* ---- tile construction --------------------------------------------------- */
  function calendarMarkup(host) {
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth();
    const first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    host.appendChild(U.el('div', { class: 'widget-title', text: year + ' 年 ' + (month + 1) + ' 月' }));
    const cal = U.el('div', { class: 'widget-cal' });
    ['日', '一', '二', '三', '四', '五', '六'].forEach(function (w) { cal.appendChild(U.el('span', { text: w })); });
    for (let i = 0; i < first; i++) cal.appendChild(U.el('span', { text: '' }));
    for (let d = 1; d <= days; d++) cal.appendChild(U.el(d === now.getDate() ? 'b' : 'span', { text: String(d) }));
    host.appendChild(cal);
  }

  function todoMarkup(host) {
    const todos = NT.state.data.todos || [];
    const list = U.el('div', { class: 'widget-todo' });
    todos.slice(0, 4).forEach(function (todo, index) {
      const check = U.el('input', { type: 'checkbox' });
      check.checked = !!todo.done;
      check.addEventListener('change', function () {
        NT.state.data.todos[index].done = check.checked;
        NT.state.changed({});
      });
      check.addEventListener('click', function (e) { e.stopPropagation(); });
      const label = U.el('label', {}, [check, U.el('span', { text: todo.text })]);
      label.addEventListener('click', function (e) { e.stopPropagation(); });
      list.appendChild(label);
    });
    host.appendChild(list);
    const add = U.el('button', { class: 'text-btn', type: 'button', text: '+ 添加待办' });
    add.addEventListener('click', function (e) {
      e.stopPropagation();
      NT.dialogs.prompt('添加待办', '内容', '', function (text) {
        NT.state.data.todos.push({ text: text, done: false });
        NT.state.changed({ grid: true });
      });
    });
    host.appendChild(add);
  }

  /* ---- 同站聚合文件夹图标 ---------------------------------------------------
     1x1 文件夹内 ≥3 个磁贴时统计主域（hostname 末两段，去 www.），某主域磁贴数
     **严格过半**即聚合：四宫格改为「单张主图（该主域下第一个有自定义图标的磁贴，
     否则第一个同域磁贴）+ 右下角数量角标」，一眼可辨站点与容量；域分散/尺寸
     不符时保持原四宫格预览。 */
  function hostOf(url) {
    try {
      return new URL(U.normalizeUrl(url)).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    } catch (e) { return ''; }
  }
  function sameSiteInfo(item) {
    if ((item.size || '1x1') !== '1x1') return null;
    const items = item.children || [];
    if (items.length < 3) return null;
    const tally = {};
    let best = '', bestN = 0;
    items.forEach(function (child) {
      const h = child.url ? hostOf(child.url) : '';
      if (!h) return;
      tally[h] = (tally[h] || 0) + 1;
      if (tally[h] > bestN) { best = h; bestN = tally[h]; }
    });
    if (bestN * 2 <= items.length) return null;
    const sameHost = items.filter(function (c) { return c.url && hostOf(c.url) === best; });
    const main = sameHost.find(function (c) { return c.icon; }) || sameHost[0];
    return { main: main, count: items.length };
  }

  function makeTile(item) {
    const node = U.$('#tplTile').content.firstElementChild.cloneNode(true);
    const iconBox = U.$('.tile-icon', node);
    const letter = U.$('.tile-letter', node);
    const img = U.$('img', node);
    const widgetBox = U.$('.tile-widget', node);
    const title = U.$('.tile-title', node);
    node.dataset.id = item.id;
    node.dataset.size = item.size || '1x1';
    node.title = item.title || '';
    title.textContent = item.title || '';

    if (item.type === 'folder') {
      img.remove(); letter.remove();
      iconBox.classList.add('is-folder');
      if (NT.dialogs.isFolderLocked(item)) {
        // 私密文件夹：不渲染内容图标，只显示白色锁覆盖层。
        iconBox.appendChild(U.el('span', { class: 'folder-lock', html: '<svg class="ico"><use href="#i-lock"/></svg>' }));
      } else {
        const agg = sameSiteInfo(item);
        if (agg) {
          // 同站聚合：单张站点主图 + 右下角数量角标。
          const mainWrap = U.el('span', { class: 'folder-main' });
          mainWrap.appendChild(U.el('span', { class: 'tile-letter', text: agg.main.letter || U.letter(agg.main.title, agg.main.url) }));
          const mainImg = U.el('img', { alt: '', draggable: 'false' });
          mainWrap.appendChild(mainImg);
          iconBox.appendChild(mainWrap);
          NT.icons.apply(mainImg, mainWrap, agg.main);
          iconBox.appendChild(U.el('span', { class: 'folder-same-site-badge', text: String(agg.count) }));
        } else {
          const preview = U.el('div', { class: 'tile-folder-preview' });
          for (let i = 0; i < 4; i++) {
            const child = (item.children || [])[i];
            const cell = U.el('span');
            if (child) {
              cell.style.background = child.color && child.color !== 'transparent' ? child.color : 'transparent';
              const childImg = U.el('img', { alt: '', draggable: 'false' });
              cell.appendChild(childImg);
              NT.icons.apply(childImg, cell, child);
            }
            else cell.classList.add('is-empty');
            preview.appendChild(cell);
          }
          iconBox.appendChild(preview);
        }
      }
    } else if (item.type === 'widget') {
      iconBox.hidden = true;
      widgetBox.hidden = false;
      if (item.widget === 'todo') todoMarkup(widgetBox);
      else calendarMarkup(widgetBox);
    } else if (item.type === 'action') {
      img.remove();
      iconBox.classList.add('is-letter', 'is-action');
      letter.textContent = item.action === 'add' ? '+' : '⚙';
      letter.style.background = 'transparent';
    } else {
      letter.textContent = item.letter || U.letter(item.title, item.url);
      // 图标背景默认全透明：只有用户显式设置背景色才填充。
      const bg = item.color && item.color !== 'transparent' ? item.color : 'transparent';
      letter.style.background = bg;
      iconBox.style.background = bg;
      // Letter is the placeholder while a site icon is still resolving.
      iconBox.classList.add('is-letter');
      NT.icons.apply(img, iconBox, item);
    }
    return node;
  }

  function buildPage(desk, isCurrent) {
    const page = U.el('section', { class: 'desk-page' + (isCurrent ? ' is-current' : '') });
    const grid = U.el('div', { class: 'grid' });
    if (isCurrent) grid.id = 'grid';
    if (desk) (desk.items || []).forEach(function (item) { grid.appendChild(makeTile(item)); });
    page.appendChild(grid);
    return page;
  }

  function render() {
    if (!track) return;
    const data = NT.state.data;
    const n = data.desks.length;
    let index = data.desks.findIndex(function (d) { return d.id === data.activeDeskId; });
    if (index < 0) index = 0;
    track.textContent = '';
    [-1, 0, 1].forEach(function (offset) {
      const slot = index + offset;
      track.appendChild(buildPage(slot >= 0 && slot < n ? data.desks[slot] : null, offset === 0));
    });
    currentGrid = U.$('#grid');
    const active = data.desks[index];
    U.$('#emptyHint').hidden = !active || (active.items || []).length > 0;
    layout();
    // Rebuilt pages always start at the middle slot, with no transition.
    track.classList.add('is-dragging');
    track.style.transform = 'translate3d(-100%, 0, 0)';
    void track.offsetWidth;
    track.classList.remove('is-dragging');
  }

  /* ---- drag & drop ordering ------------------------------------------------ */
  function parseDrag(e) {
    try { return JSON.parse(e.dataTransfer.getData('text/plain')); }
    catch (err) { return null; }
  }

  function isDescendant(item, targetId) {
    if (!item || !item.children) return false;
    return item.children.some(function (child) { return child.id === targetId || isDescendant(child, targetId); });
  }

  function moveTile(sourceId, targetId, position, targetDeskId) {
    const source = NT.state.findItem(sourceId);
    if (!source) return;
    if (isDescendant(source.item, targetId) || sourceId === targetId) return;
    const item = source.list.splice(source.index, 1)[0];
    let list, index;

    if (targetDeskId) {
      const desk = NT.state.data.desks.find(function (d) { return d.id === targetDeskId; });
      if (!desk) { source.list.splice(source.index, 0, item); return; }
      list = desk.items;
      index = list.length;
    } else if (targetId) {
      const target = NT.state.findItem(targetId);
      if (!target) { source.list.splice(source.index, 0, item); return; }
      if (target.item.type === 'folder') { list = target.item.children; index = list.length; }
      else { list = target.list; index = target.index + (position === 'after' ? 1 : 0); }
    } else {
      list = NT.state.activeDesk().items;
      index = list.length;
    }
    list.splice(U.clamp(index, 0, list.length), 0, item);
    NT.state.changed({ grid: true });
  }

  function clearDragStyles() {
    U.$$('.tile.is-dragging, .tile.is-drop-target').forEach(function (node) {
      node.classList.remove('is-dragging', 'is-drop-target');
    });
    if (currentGrid) currentGrid.classList.remove('is-drop-target');
  }

  /* ---- pointer / keyboard interaction ------------------------------------- */
  function bind() {
    track.addEventListener('click', function (e) {
      const tile = e.target.closest('.tile');
      if (!tile || tile.dataset.suppressClick === '1') { if (tile) delete tile.dataset.suppressClick; return; }
      // Clicks landing on a neighbour page switch to that desktop instead.
      const page = tile.closest('.desk-page');
      if (page && !page.classList.contains('is-current')) { NT.desks.pageClickFromTile(tile); return; }
      if (e.target.closest('.tile-widget')) return;
      const found = NT.state.findItem(tile.dataset.id);
      if (!found) return;
      const item = found.item;
      if (item.type === 'folder') NT.dialogs.openFolderGate(item.id);
      else if (item.type === 'action') {
        if (item.action === 'settings') NT.settings.open();
        else NT.dialogs.editTile();
      } else if (item.type === 'link') U.openUrl(item.url, NT.state.data.config.iconBlank);
    });

    track.addEventListener('contextmenu', function (e) {
      const tile = e.target.closest('.tile');
      e.preventDefault();
      if (tile) NT.dialogs.tileMenu(e.clientX, e.clientY, tile.dataset.id);
      else NT.dialogs.deskMenu(e.clientX, e.clientY);
    });

    // ---- 安卓桌面式长按：菜单 / 拖动 / 合并文件夹 ---------------------------
    // 照抄现代安卓（Pixel Launcher）桌面操作：长按图标弹出上下文菜单，按住
    // 不放继续移动则收起菜单、图标抬起进入拖动，其他图标实时让位（FLIP），
    // 悬停在某个图标中心片刻松手即合并为文件夹。没有编辑态、没有删除角标、
    // 没有抖动——删除走长按/右键菜单。磁贴不再使用 HTML5 原生拖拽：一是
    // 避免「按下即拖」，二是 Chrome 会把拖起的 <img> 图标当文件丢进
    // 「拖图换壁纸」，造成壁纸被换。
    const HOLD_MS = 500;        // 安卓长按阈值
    const MERGE_MS = 380;       // 悬停多久视为「合并到该图标」
    let press = null;

    function gridTiles() {
      return currentGrid ? Array.prototype.slice.call(currentGrid.children) : [];
    }

    /* DOM 顺序改变后，其他图标从旧位置平滑滑到新位置（先倒放再归位）。 */
    function flipShift(mutate) {
      const moving = gridTiles();
      const before = moving.map(function (n) { return n.getBoundingClientRect(); });
      mutate();
      moving.forEach(function (n, i) {
        if (press && press.tile === n) return; // 抬起的磁贴由手指驱动，不参与
        const dx = before[i].left - n.getBoundingClientRect().left;
        const dy = before[i].top - n.getBoundingClientRect().top;
        if (!dx && !dy) return;
        if (n.__flipTimer) clearTimeout(n.__flipTimer);
        n.style.transition = 'none';
        n.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
        void n.offsetWidth;
        n.style.transition = 'transform 0.18s ease';
        n.style.transform = '';
        n.__flipTimer = setTimeout(function () { n.style.transition = ''; }, 220);
      });
    }

    /* 指针落在哪个槽位：最近磁贴 + 左右半边决定插到它前面还是后面。 */
    function hitSlot(x, y, exclude) {
      const others = gridTiles().filter(function (n) { return n !== exclude; });
      if (!others.length) return 0;
      let best = null, bestD = Infinity;
      others.forEach(function (n) {
        const r = n.getBoundingClientRect();
        const cx = Math.max(r.left, Math.min(x, r.right));
        const cy = Math.max(r.top, Math.min(y, r.bottom));
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bestD) { bestD = d; best = { node: n, rect: r }; }
      });
      const i = others.indexOf(best.node);
      return i + (x > best.rect.left + best.rect.width / 2 ? 1 : 0);
    }

    function releasePress() {
      if (!press) return;
      clearTimeout(press.menuTimer);
      clearTimeout(press.mergeTimer);
      press = null;
    }

    /* 长按：在按住的位置弹出磁贴菜单，同时进入「按住即可拖动」状态。 */
    function openTileMenu() {
      const p = press;
      if (!p || NT.desks.slideClaimed || !p.tile.isConnected) { releasePress(); return; }
      NT.desks.cancelGesture();          // 拖动期间页面滑动让位
      p.armed = true;
      p.tile.dataset.suppressClick = '1';
      menuGuard = true;                  // 吞掉紧随的 click，避免菜单被立即关闭
      NT.dialogs.tileMenu(p.x0, p.y0, p.tile.dataset.id);
    }

    /* 抬起进入拖动。 */
    function lift(p) {
      const r = p.tile.getBoundingClientRect();
      p.base = { left: r.left, top: r.top };
      p.gx = p.x0 - r.left;              // 手指抓在图标内的落点
      p.gy = p.y0 - r.top;
      p.dx = 0; p.dy = 0;
      p.dragging = true;
      p.tile.classList.add('is-lifted');
      document.body.classList.add('is-dragging-tile');
    }

    /* DOM 重排后基准位置变了：按当前位移反推新基准，图标保持贴住手指。 */
    function reanchor(p) {
      const r = p.tile.getBoundingClientRect();
      p.base = { left: r.left - p.dx, top: r.top - p.dy };
    }

    function cancelMerge(p) {
      clearTimeout(p.mergeTimer);
      if (p.mergeTarget) p.mergeTarget.classList.remove('is-merge-target');
      p.mergeTarget = null;
      p.mergeReady = false;
    }

    /* 悬停合并（安卓）：指针在某图标中心停留片刻 → 该图标放大提示；
       移开则取消。合并就绪期间冻结排序预览。 */
    function mergeHover(x, y, p) {
      if (p.mergeReady) {
        const r = p.mergeTarget.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (Math.hypot(x - cx, y - cy) > Math.max(r.width, r.height) * 0.55) cancelMerge(p);
        else return;
      }
      const others = gridTiles().filter(function (n) { return n !== p.tile; });
      let cand = null, bestD = Infinity;
      others.forEach(function (n) {
        const r = n.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const d = Math.hypot(x - cx, y - cy);
        if (d < Math.max(r.width, r.height) * 0.42 && d < bestD) { bestD = d; cand = n; }
      });
      if (!cand || cand !== p.mergeTarget) {
        cancelMerge(p);
        if (cand) {
          p.mergeTarget = cand;
          p.mergeTimer = setTimeout(function () {
            if (press === p && p.mergeTarget === cand && !p.mergeReady) {
              p.mergeReady = true;
              cand.classList.add('is-merge-target');
            }
          }, MERGE_MS);
        }
      }
    }

    /* 松手合并：拖到图标上=新建文件夹；拖到文件夹上=移入；文件夹并入文件夹。 */
    function mergeItems(draggedId, targetId) {
      const a = NT.state.findItem(draggedId), b = NT.state.findItem(targetId);
      if (!a || !b || a.item === b.item) return false;
      const d = a.item, t = b.item;
      if (d.type === 'widget' || t.type === 'widget') return false; // 小组件不进文件夹
      if (t.type === 'folder') {
        if (d.type === 'folder') t.children = t.children.concat(d.children);
        else t.children.push(d);
        const i = a.list.indexOf(d);
        if (i >= 0) a.list.splice(i, 1);
        NT.state.changed({ grid: true });
        // 拖入私密文件夹：合并生效但不弹层（悬停不展开，避免泄露内容）。
        if (!NT.dialogs.isFolderLocked(t)) NT.dialogs.openFolder(t.id);
        return true;
      }
      if (d.type === 'folder') return false;
      const folder = { id: U.uid(), type: 'folder', title: '新建文件夹', size: '1x1', children: [t, d] };
      const iT = b.list.indexOf(t);
      const iD = a.list.indexOf(d);
      if (iT >= 0) b.list.splice(iT, 1);
      if (iD >= 0) a.list.splice(iD, 1);
      b.list.splice(U.clamp(iT, 0, b.list.length), 0, folder);
      // 新建文件夹（未上锁）合并完成后直接打开预览。
      NT.state.changed({ grid: true });
      NT.dialogs.openFolder(folder.id);
      return true;
    }

    /* 拖动经过其他磁贴时实时腾出位置（松手前就生效；合并就绪时冻结）。 */
    function previewOrder(x, y, p) {
      if (!currentGrid || p.mergeReady) return;
      const c = Array.prototype.indexOf.call(currentGrid.children, p.tile);
      const k = hitSlot(x, y, p.tile);
      if (k < 0 || k === c) return;
      flipShift(function () {
        const others = gridTiles().filter(function (n) { return n !== p.tile; });
        currentGrid.insertBefore(p.tile, others[Math.min(k, others.length)] || null);
      });
      reanchor(p);
    }

    function finishDrag(commit) {
      const p = press;
      const merging = !!(p && p.mergeReady && p.mergeTarget);
      const targetId = merging ? p.mergeTarget.dataset.id : null;
      releasePress();
      if (!p) return;
      document.body.classList.remove('is-dragging-tile');
      if (!p.armed) return;
      p.tile.classList.remove('is-lifted');
      p.tile.style.transform = '';
      if (!p.dragging) return;
      justDragged = true;                // 吞掉松手后的那次 click，防止误开链接
      if (commit && merging) {           // 安卓式：松手在图标上 → 合并成文件夹
        mergeItems(p.tile.dataset.id, targetId);
        return;
      }
      const id = p.tile.dataset.id;
      const list = NT.state.activeDesk().items;
      const from = list.findIndex(function (it) { return it.id === id; });
      const to = Array.prototype.indexOf.call(currentGrid.children, p.tile);
      if (from < 0 || to < 0 || to === from) return;
      if (commit) {
        const moved = list.splice(from, 1)[0];
        list.splice(U.clamp(to, 0, list.length), 0, moved);
        NT.state.changed({ grid: true });  // 重渲染，按新顺序落位
      } else {
        render();                          // 未提交（取消）：按数据恢复原位
      }
    }

    let justDragged = false, menuGuard = false, menuGuardTimer = 0;
    document.addEventListener('click', function (e) {
      // 吞掉长按菜单弹出后紧随的那次 click（否则菜单会被立刻关闭）。
      if (menuGuard) {
        menuGuard = false;
        clearTimeout(menuGuardTimer);
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (!justDragged) return;
      justDragged = false;
      // 只吞落回桌面区域的误点击（防止拖完松手误开链接），不影响其他控件。
      if (e.target.closest && e.target.closest('.tile, .grid, .desk-track, .dots')) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    track.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      const tile = e.target.closest && e.target.closest('.tile');
      if (!tile || e.target.closest('.tile-widget, button, input, textarea, select')) return;
      releasePress();
      const p = { tile: tile, id: e.pointerId, x0: e.clientX, y0: e.clientY,
                  armed: false, dragging: false, mergeReady: false, mergeTarget: null };
      press = p;
      p.menuTimer = setTimeout(openTileMenu, HOLD_MS);
    });
    global.addEventListener('pointermove', function (e) {
      if (!press) return;
      if (press.id !== undefined && e.pointerId !== undefined && e.pointerId !== press.id) return;
      if (!press.armed) {
        if (Math.abs(e.clientX - press.x0) > 10 || Math.abs(e.clientY - press.y0) > 10) releasePress();
        return;
      }
      if (e.cancelable) e.preventDefault();
      if (!press.dragging) {
        if (Math.abs(e.clientX - press.x0) > 8 || Math.abs(e.clientY - press.y0) > 8) {
          NT.dialogs.closeMenu();          // 按住不放继续移动 → 收起菜单开始拖动
          menuGuard = false;
          clearTimeout(menuGuardTimer);
          lift(press);
        } else return;
      }
      press.dx = e.clientX - (press.base.left + press.gx);
      press.dy = e.clientY - (press.base.top + press.gy);
      press.tile.style.transform = 'translate3d(' + press.dx.toFixed(1) + 'px,' + press.dy.toFixed(1) + 'px,0)';
      previewOrder(e.clientX, e.clientY, press);
      mergeHover(e.clientX, e.clientY, press);
    }, { passive: false });
    ['pointerup', 'pointercancel'].forEach(function (name) {
      global.addEventListener(name, function (e) {
        if (!press) return;
        if (press.id !== undefined && e.pointerId !== undefined && e.pointerId !== press.id) return;
        // 菜单已弹出但没拖动时，真正的 click 由 menuGuard 吞掉；
        // 这里兜底：若浏览器没派发 click，定时让守卫过期，不影响后续点击。
        if (menuGuard) menuGuardTimer = setTimeout(function () { menuGuard = false; }, 500);
        finishDrag(name === 'pointerup');
      });
    });
    document.addEventListener('selectstart', function (e) {
      if (press && press.armed) e.preventDefault();
    });

    track.addEventListener('dragstart', function (e) {
      // 磁贴与文件夹内的图标一律禁止原生拖拽（排序走上面的指针拖动）。
      if (e.target.closest && e.target.closest('.tile')) e.preventDefault();
    });
    track.addEventListener('dragover', function (e) {
      e.preventDefault();
      const tile = e.target.closest('.tile');
      clearDragStyles();
      if (tile) {
        const box = tile.getBoundingClientRect();
        tile.dataset.dropPosition = e.clientX < box.left + box.width / 2 ? 'before' : 'after';
        tile.classList.add('is-drop-target');
      } else if (currentGrid) currentGrid.classList.add('is-drop-target');
    });
    track.addEventListener('dragleave', function (e) {
      if (!track.contains(e.relatedTarget)) clearDragStyles();
    });
    track.addEventListener('drop', function (e) {
      e.preventDefault();
      const payload = parseDrag(e);
      clearDragStyles();
      // 只处理从浏览器拖进来的书签；磁贴排序走上面的指针拖动。
      if (payload && payload.kind === 'bookmark') {
        NT.state.addItem({ id: U.uid(), type: 'link', title: payload.title, url: payload.url, icon: '', color: '', letter: '', size: '1x1' });
      }
    });
    track.addEventListener('dragend', clearDragStyles);

    global.addEventListener('resize', layout);
    if (global.ResizeObserver) new ResizeObserver(layout).observe(shell);
  }

  NT.grid = {
    init: function () { track = U.$('#deskTrack'); shell = U.$('#deskVp'); bind(); },
    render: render, layout: layout, moveTile: moveTile, clearDragStyles: clearDragStyles,
    current: function () { return currentGrid; }
  };
})(window);
