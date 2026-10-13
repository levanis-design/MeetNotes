'use strict';
// Floating recording widget. It only displays state sent by the main window and sends commands back.
(function () {
  const api = window.miniApi;
  const $ = (id) => document.getElementById(id);
  const widget = $('widget');
  const bars = Array.from($('eq').children);
  const SHAPE = [0.6, 0.9, 1, 0.8, 0.55];

  const ICON = {
    pause: '<svg viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" rx="1.2" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1.2" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 16 16"><path d="M5.2 3.4v9.2c0 .5.5.8.9.5l7-4.6a.6.6 0 0 0 0-1l-7-4.6c-.4-.3-.9 0-.9.5z" fill="currentColor"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.2l4 4 4-4"/></svg>',
    up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.8l4-4 4 4"/></svg>',
  };

  const st = {
    size: 'pill',
    appearance: 'solid',
    opacity: 55,
    state: null,
    recvAt: Date.now(),
    levels: { you: 0, others: 0 },
    levelAt: 0,
    smooth: bars.map(() => 0.18),
    hover: false,
    dragging: false,
  };

  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }

  function applyClasses() {
    widget.classList.remove('size-card', 'size-pill', 'size-dot');
    widget.classList.add('size-' + st.size);
    widget.classList.toggle('transparent', st.appearance === 'transparent');
    widget.classList.toggle('idle', !st.hover && !st.dragging);
    widget.classList.toggle('paused', Boolean(st.state && st.state.paused));
    widget.style.setProperty('--idle-opacity', String(Math.min(1, Math.max(0.2, st.opacity / 100))));
    const sizeBtn = $('sizeBtn');
    sizeBtn.innerHTML = st.size === 'card' ? ICON.up : ICON.down;
    sizeBtn.title = st.size === 'card' ? 'Show less' : 'Show details';
    sizeBtn.setAttribute('aria-label', sizeBtn.title);
  }

  function renderState() {
    const s = st.state;
    const paused = Boolean(s && s.paused);
    $('statusText').textContent = paused ? 'PAUSED' : 'REC';
    $('pauseBtn').innerHTML = paused ? ICON.play : ICON.pause;
    $('pauseBtn').title = paused ? 'Resume' : 'Pause';
    $('pauseBtn').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    $('title').textContent = (s && s.title) || '';
    const last = s && s.last;
    $('last').textContent = last ? `${last.source === 'you' ? 'You' : 'Others'}: ${last.text}` : 'Listening...';
    applyClasses();
    tickTimer();
  }

  function elapsed() {
    const s = st.state;
    if (!s) return 0;
    if (s.live && !s.paused) return (s.elapsed || 0) + (Date.now() - st.recvAt) / 1000;
    return s.elapsed || 0;
  }
  function tickTimer() {
    $('timer').textContent = fmt(elapsed());
  }

  // Level meter: smooth, slightly organic bars driven by the louder of the two sources.
  function animateBars() {
    const s = st.state;
    const now = Date.now();
    let you = 0, others = 0;
    if (s && s.preview) {
      const t = now / 1000;
      you = Math.max(0, Math.sin(t * 2.1)) * 0.06;
      others = Math.max(0, Math.sin(t * 1.3 + 1)) * 0.09;
    } else if (s && s.live && !s.paused && now - st.levelAt < 600) {
      you = st.levels.you;
      others = st.levels.others;
    }
    const level = Math.max(you, others);
    const base = Math.min(1, Math.sqrt(level) * 2.4);
    bars.forEach((bar, i) => {
      const jitter = level > 0.004 ? 0.75 + Math.random() * 0.5 : 1;
      const target = Math.max(0.16, base * SHAPE[i] * jitter);
      st.smooth[i] = st.smooth[i] * 0.55 + target * 0.45;
      bar.style.transform = `scaleY(${st.smooth[i].toFixed(3)})`;
    });
    $('whoYou').classList.toggle('active', you > 0.012);
    $('whoOthers').classList.toggle('active', others > 0.012);
  }

  // ---------- controls ----------
  $('pauseBtn').addEventListener('click', () => api.command(st.state && st.state.paused ? 'resume' : 'pause'));
  $('stopBtn').addEventListener('click', () => api.command('stop'));
  $('openBtn').addEventListener('click', () => api.command('open'));
  $('sizeBtn').addEventListener('click', () => api.setSize(st.size === 'card' ? 'pill' : 'card'));
  $('minBtn').addEventListener('click', () => api.setSize('dot'));
  $('hideBtn').addEventListener('click', () => api.hide());

  // ---------- drag anywhere on the widget; a plain click on the dot expands it ----------
  let drag = null;
  $('surface').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.ib')) return;
    drag = { x: e.screenX, y: e.screenY, lastX: e.screenX, lastY: e.screenY, moved: false };
    $('surface').setPointerCapture(e.pointerId);
  });
  $('surface').addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 4) return;
    drag.moved = true;
    st.dragging = true;
    applyClasses();
    api.moveBy(e.screenX - drag.lastX, e.screenY - drag.lastY);
    drag.lastX = e.screenX;
    drag.lastY = e.screenY;
  });
  function endDrag() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    st.dragging = false;
    applyClasses();
    if (moved) api.dragEnd();
    else if (st.size === 'dot') api.setSize('pill');
  }
  $('surface').addEventListener('pointerup', endDrag);
  $('surface').addEventListener('pointercancel', endDrag);

  document.body.addEventListener('mouseenter', () => { st.hover = true; applyClasses(); });
  document.body.addEventListener('mouseleave', () => { st.hover = false; applyClasses(); });
  document.addEventListener('mouseover', () => { if (!st.hover) { st.hover = true; applyClasses(); } });

  // ---------- messages from the main process ----------
  api.onState((s) => {
    st.state = s;
    st.recvAt = Date.now();
    renderState();
  });
  api.onLevels((l) => {
    st.levels = { you: Number(l && l.you) || 0, others: Number(l && l.others) || 0 };
    st.levelAt = Date.now();
  });
  api.onSettings((s) => {
    if (s.size) st.size = s.size;
    if (s.appearance) st.appearance = s.appearance;
    if (typeof s.opacity === 'number') st.opacity = s.opacity;
    applyClasses();
  });

  setInterval(tickTimer, 250);
  setInterval(animateBars, 70);
  applyClasses();
  renderState();
  api.ready();
})();
