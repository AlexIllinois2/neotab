/* NeoTab — phone-desktop paging.
   Three full-width pages (previous / current / next) sit in a horizontal
   track. Swipes follow the finger in real time on three input paths:
   touch, mouse drag and trackpad horizontal wheel. Releasing commits a page
   when the displacement passes 22% of the viewport or the gesture is a flick.
   The bottom dots, arrow keys and click-on-dot jump directly. */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;

  let track, vp, dots;
  let suppressUntil = 0;
  let wheelTimer = 0;
  let wheelDx = 0;
  let wheelLastT = 0;
  let gesture = null;

  const SKIP = '.dots,.settings,.layer,.context-menu,.notes-panel,input,textarea,select,[contenteditable],button';

  function desks() { return NT.state.data.desks; }
  function activeIndex() {
    const i = desks().findIndex(function (d) { return d.id === NT.state.data.activeDeskId; });
    return i < 0 ? 0 : i;
  }
  function overlaysOpen() {
    return !U.$('#settings').hidden || !U.$('#dialogLayer').hidden ||
      !U.$('#folderLayer').hidden || !U.$('#globalSearchLayer').hidden ||
      !U.$('#contextMenu').hidden;
  }

  /* ---- page dots ----------------------------------------------------------- */
  function render() {
    if (!dots) return;
    dots.textContent = '';
    const list = desks();
    list.forEach(function (d, index) {
      const dot = U.el('button', {
        type: 'button',
        class: 'dot' + (d.id === NT.state.data.activeDeskId ? ' is-active' : ''),
        title: d.name, 'aria-label': '切换到 ' + d.name,
        onclick: function () { switchTo(index); }
      });
      dot.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        NT.dialogs.deskItemMenu(e.clientX, e.clientY, d.id);
      });
      // Long press a dot to rename / delete that desktop (touch friendly).
      let hold = 0;
      dot.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse') return;
        hold = setTimeout(function () { NT.dialogs.deskItemMenu(e.clientX, e.clientY, d.id); }, 600);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
        dot.addEventListener(name, function () { clearTimeout(hold); });
      });
      dots.appendChild(dot);
    });
    dots.hidden = list.length < 2;
  }

  /* ---- transform helpers --------------------------------------------------- */
  function baseTransform() { return 'translate3d(-100%, 0, 0)'; }

  function follow(dx) {
    if (!track) return;
    let d = dx;
    const idx = activeIndex(), last = desks().length - 1;
    if ((idx === 0 && d > 0) || (idx === last && d < 0)) d *= 0.32; // rubber band
    track.style.transform = 'translate3d(calc(-100% + ' + d.toFixed(1) + 'px), 0, 0)';
  }

  let pendingDone = null;
  function onceTransitionEnd(fn) {
    if (pendingDone) { pendingDone.cancelled = true; track.removeEventListener('transitionend', pendingDone.handler); }
    const job = { cancelled: false, handler: null };
    const run = function () {
      if (job.cancelled) return;
      job.cancelled = true;
      track.removeEventListener('transitionend', job.handler);
      clearTimeout(job.timer);
      pendingDone = null;
      fn();
    };
    job.handler = function (e) { if (e && e.target !== track) return; run(); };
    track.addEventListener('transitionend', job.handler);
    job.timer = setTimeout(run, 380);
    pendingDone = job;
  }

  function switchTo(target) {
    const list = desks();
    if (target < 0 || target >= list.length || target === activeIndex() || !track) return;
    track.classList.remove('is-dragging');
    const dir = target > activeIndex() ? 1 : -1;
    track.style.transform = 'translate3d(' + (-100 - dir * 100) + '%, 0, 0)';
    onceTransitionEnd(function () { NT.state.setActiveDesk(list[target].id); });
  }

  function step(delta) { switchTo(activeIndex() + delta); }

  function settle(dx, velocity) {
    if (!track) return;
    track.classList.remove('is-dragging');
    const w = vp.clientWidth || 1;
    const ratio = Math.abs(dx) / w;
    const flick = Math.abs(velocity) > 0.45 && Math.abs(dx) > 42;
    const commit = Math.abs(dx) > 18 && (ratio >= 0.22 || flick);
    suppressUntil = Date.now() + 350;
    if (!commit) { track.style.transform = baseTransform(); return; }
    const dir = dx < 0 ? 1 : -1;
    const target = activeIndex() + dir;
    if (target < 0 || target >= desks().length) { track.style.transform = baseTransform(); return; }
    track.style.transform = 'translate3d(' + (-100 - dir * 100) + '%, 0, 0)';
    onceTransitionEnd(function () { NT.state.setActiveDesk(desks()[target].id); });
  }

  /* ---- gesture: touch + mouse --------------------------------------------- */
  function begin(e, mode) {
    if (overlaysOpen() || pendingDone) return;
    if (e.target.closest && e.target.closest(SKIP)) return;
    if (mode === 'mouse' && e.button !== 0) return;
    gesture = {
      mode: mode, id: e.pointerId,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      t0: Date.now(), t: Date.now(), dx: 0, v: 0, engaged: false
    };
    api.slideClaimed = false;
  }

  function move(e) {
    if (!gesture || gesture.engaged && gesture.mode === 'wheel') return;
    if (gesture.id !== undefined && e.pointerId !== undefined && e.pointerId !== gesture.id) return;
    const dxTotal = e.clientX - gesture.x0;
    const dyTotal = e.clientY - gesture.y0;
    if (!gesture.engaged) {
      // Horizontal-dominant motion claims the swipe; vertical motion is left
      // to the browser for natural page scrolling (and to icon long-press).
      if (Math.abs(dxTotal) < 6 || Math.abs(dxTotal) <= Math.abs(dyTotal) * 1.1) return;
      gesture.engaged = true;
      api.slideClaimed = true;
      track.classList.add('is-dragging');
    }
    const now = Date.now();
    const dt = Math.max(1, now - gesture.t);
    gesture.v = (e.clientX - gesture.x) / dt;
    gesture.x = e.clientX; gesture.y = e.clientY; gesture.t = now;
    gesture.dx = dxTotal;
    follow(dxTotal);
    if (e.cancelable) e.preventDefault();
  }

  function end() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    api.slideClaimed = false;
    if (!g.engaged) return;
    settle(g.dx, g.v);
  }

  /* Icon dragging takes over the pointer: drop any pending page swipe. */
  function cancelGesture() {
    gesture = null;
    api.slideClaimed = false;
    clearTimeout(wheelTimer);
    wheelDx = 0;
    if (track) track.classList.remove('is-dragging');
  }

  /* ---- gesture: trackpad horizontal wheel ---------------------------------- */
  function onWheel(e) {
    if (overlaysOpen() || pendingDone || gesture) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 1) {
      if (wheelDx) { wheelDx = 0; track.classList.remove('is-dragging'); track.style.transform = baseTransform(); }
      return;
    }
    if (e.cancelable) e.preventDefault();
    const now = Date.now();
    if (!wheelDx) { wheelLastT = now; track.classList.add('is-dragging'); }
    // Content follows the fingers: two-finger left (deltaX > 0) -> next desk.
    wheelDx -= e.deltaX * 0.3;
    wheelLastT = now;
    follow(wheelDx);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(function () {
      const dx = wheelDx;
      wheelDx = 0;
      settle(dx, 0);
    }, 250);
  }

  /* ---- init ---------------------------------------------------------------- */
  function init() {
    track = U.$('#deskTrack');
    vp = U.$('#deskVp');
    dots = U.$('#dots');

    vp.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;   // mouse handled by mousedown
      begin(e, 'touch');
    });
    vp.addEventListener('mousedown', function (e) {
      if (gesture && gesture.mode === 'touch') return;  // ignore synthesized mouse events
      begin(e, 'mouse');
    });
    global.addEventListener('pointermove', function (e) {
      if (gesture && gesture.mode !== 'mouse') move(e);
    }, { passive: false });
    global.addEventListener('mousemove', function (e) { if (gesture && gesture.mode === 'mouse') move(e); }, { passive: false });
    global.addEventListener('pointerup', end);
    global.addEventListener('pointercancel', end);
    global.addEventListener('mouseup', function () { if (gesture && gesture.mode === 'mouse') end(); });
    vp.addEventListener('wheel', onWheel, { passive: false });

    // Suppress the click that lands right after a swipe.
    vp.addEventListener('click', function (e) {
      if (Date.now() < suppressUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    // Long press empty space opens the desktop menu (touch equivalent of right click).
    let blankHold = 0, hx = 0, hy = 0;
    vp.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || e.target.closest('.tile')) return;
      hx = e.clientX; hy = e.clientY;
      clearTimeout(blankHold);
      blankHold = setTimeout(function () {
        if (api.slideClaimed) return;
        NT.dialogs.deskMenu(hx, hy);
      }, 620);
    });
    ['pointerup', 'pointercancel', 'pointermove'].forEach(function (name) {
      vp.addEventListener(name, function (e) {
        if (name === 'pointermove' && Math.abs(e.clientX - hx) < 10 && Math.abs(e.clientY - hy) < 10) return;
        clearTimeout(blankHold);
      });
    });

    U.$('#btnAddDesk').addEventListener('click', function () {
      NT.dialogs.prompt('新建桌面', '桌面名称', '桌面 ' + (desks().length + 1), function (name) {
        NT.state.addDesk(name);
        U.toast('已创建桌面「' + name + '」');
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (overlaysOpen()) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      step(e.key === 'ArrowRight' ? 1 : -1);
    });
  }

  const api = {
    init: init, render: render, step: step, switchTo: switchTo,
    cancelGesture: cancelGesture,
    slideClaimed: false,
    pageClickFromTile: function (tile) {
      const page = tile.closest('.desk-page');
      if (!page || !track) return;
      const slot = Array.prototype.indexOf.call(track.children, page);
      if (slot === 0) switchTo(activeIndex() - 1);
      else if (slot === 2) switchTo(activeIndex() + 1);
    }
  };
  NT.desks = api;
})(window);
