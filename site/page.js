// Riffler home v3: progressive enhancement only. Without this file the page is complete and still.
(() => {
  const d = document.documentElement;
  const motion = d.classList.contains('motion');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---- copy buttons
  const live = $('#copy-live');
  $$('[data-copy-target]').forEach((b) => {
    const label = b.textContent;
    b.addEventListener('click', async () => {
      const el = document.getElementById(b.dataset.copyTarget);
      const text = el.textContent.trim();
      try { await navigator.clipboard.writeText(text); }
      catch {
        const r = document.createRange(); r.selectNodeContents(el);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); s.removeAllRanges();
      }
      b.textContent = b.classList.contains('copy--solid') ? 'Copied to clipboard' : 'Copied'; b.dataset.done = '';
      if (live) live.textContent = 'Copied to clipboard.';
      setTimeout(() => { b.textContent = label; delete b.dataset.done; if (live) live.textContent = ''; }, 1800);
    });
  });

  // ---- client tabs; the <details> list is the no-JS form
  const clients = $('#clients');
  if (clients) {
    const items = $$('details.client', clients);
    const list = document.createElement('div'); list.className = 'tab-list'; list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Coding agents');
    const panels = document.createElement('div'); panels.className = 'tab-panels';
    items.forEach((det, i) => {
      const id = det.dataset.client;
      const tab = document.createElement('button');
      tab.type = 'button'; tab.className = 'tab'; tab.id = `tab-${id}`; tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `panel-${id}`); tab.setAttribute('aria-selected', String(i === 0)); tab.tabIndex = i === 0 ? 0 : -1;
      tab.dataset.mark = det.dataset.mark;
      tab.append(...$('summary', det).childNodes);
      const panel = document.createElement('div');
      panel.className = 'tab-panel'; panel.id = `panel-${id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
      panel.append(...$('.client-body', det).childNodes); panel.hidden = i !== 0;
      list.append(tab); panels.append(panel); det.remove();
    });
    clients.prepend(list); clients.append(panels); clients.classList.add('tabs');
    const tabs = $$('.tab', list);
    const select = (t, focus) => {
      tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute('aria-controls')).hidden = !on; });
      if (focus) t.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (k) { e.preventDefault(); select(tabs[(i + k + tabs.length) % tabs.length], true); }
        if (e.key === 'Home') { e.preventDefault(); select(tabs[0], true); }
        if (e.key === 'End') { e.preventDefault(); select(tabs[tabs.length - 1], true); }
      });
    });
  }

  // ---- once-on-view classes (reply crew hop, parade walk)
  $$('.crew, .parade').forEach((g) => $$('.crew-one', g).forEach((c, i) => c.style.setProperty('--i', i)));
  if (motion && 'IntersectionObserver' in window) {
    const seen = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.target.classList.contains('parade')) e.target.classList.toggle('go', e.isIntersecting);
      else if (e.isIntersecting) { e.target.classList.add('seen'); seen.unobserve(e.target); }
    }), { threshold: 0.4 });
    $$('.reply-beat, .parade').forEach((el) => seen.observe(el));
  }

  // ---- contact sheet: click or draw a loop to keep; the row string, the call and the files follow
  const sheet = $('#sheet');
  if (sheet) {
    const frames = $$('.frame', sheet);
    const byPost = new Map();
    frames.forEach((f) => { const p = +f.dataset.post; if (!byPost.has(p)) byPost.set(p, []); byPost.get(p).push(f); });
    const setKept = (f, on) => {
      const btn = $('.frame-btn', f);
      f.classList.toggle('is-kept', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', `${btn.dataset.name}, ${on ? 'kept' : 'not kept'}`);
      if (on && motion) { f.classList.remove('pop'); void f.offsetWidth; f.classList.add('pop'); }
    };
    frames.forEach((f) => {
      const btn = $('.frame-btn', f);
      btn.addEventListener('click', (e) => { if (sheet.dataset.justDrew) { e.preventDefault(); return; } setKept(f, !f.classList.contains('is-kept')); update(); });
    });
    const layer = $('.draw-layer', sheet.parentNode);
    const NS = 'http://www.w3.org/2000/svg';
    if (layer && window.PointerEvent) {
      sheet.classList.add('can-draw');
      let pts = null, path = null, id = null;
      const box = () => sheet.getBoundingClientRect();
      const at = (e) => { const b = box(); return [e.clientX - b.left + 12, e.clientY - b.top + 12]; }; // layer sits on the box, 12 px padding
      const dd = (p) => {
        if (p.length < 2) return '';
        let out = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
        for (let i = 1; i < p.length - 1; i++) { const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2]; out += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`; }
        const l = p[p.length - 1]; return out + ` L${l[0].toFixed(1)} ${l[1].toFixed(1)}`;
      };
      const inside = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
      const drop = () => { if (path) path.remove(); path = null; pts = null; };
      sheet.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.pointerType === 'touch') return; // touch scrolls; tapping a frame keeps it
        pts = [at(e)]; id = e.pointerId;
        path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'live'); layer.append(path);
      });
      sheet.addEventListener('pointermove', (e) => {
        if (!pts || e.pointerId !== id) return;
        const p = at(e), q = pts[pts.length - 1];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 3) return;
        pts.push(p);
        if (pts.length === 4) { try { sheet.setPointerCapture(id); } catch (_) {} }
        path.setAttribute('d', dd(pts));
      });
      sheet.addEventListener('pointerup', (e) => {
        if (!pts || e.pointerId !== id) return;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const big = pts.length > 6 && Math.max(...xs) - Math.min(...xs) > 24 && Math.max(...ys) - Math.min(...ys) > 24;
        if (!big) { drop(); return; }
        path.setAttribute('class', '');
        const b = box(); let n = 0;
        frames.forEach((f) => {
          if (getComputedStyle(f).display === 'none') return;
          const r = f.getBoundingClientRect();
          if (inside(r.left - b.left + 12 + r.width / 2, r.top - b.top + 12 + r.height / 2, pts) && !f.classList.contains('is-kept')) { setKept(f, true); n++; }
        });
        if (!n) drop();
        else { path = null; pts = null; update(); const l = $('#sheet-live'); if (l) l.textContent = `Kept ${n} more. Rows now ${$('#keep-str').textContent}.`; }
        sheet.dataset.justDrew = '1'; setTimeout(() => { delete sheet.dataset.justDrew; }, 0);
      });
      sheet.addEventListener('pointercancel', drop);
    }
    const clear = $('#sheet-clear');
    if (clear) clear.addEventListener('click', () => {
      if (layer) layer.textContent = '';
      frames.forEach((f) => { if (f.classList.contains('is-kept')) setKept(f, false); });
      update();
      const l = $('#sheet-live'); if (l) l.textContent = 'Cleared. Nothing kept.';
    });
    function update() {
      // a post with every item kept is written as its number; consecutive whole posts become a range
      const parts = []; let rn = null;
      const flush = () => { if (rn) { parts.push(rn[0] === rn[1] ? `${rn[0]}` : `${rn[0]}-${rn[1]}`); rn = null; } };
      [...byPost.keys()].sort((a, b) => a - b).forEach((p) => {
        const fs = byPost.get(p); const k = fs.filter((f) => f.classList.contains('is-kept'));
        if (k.length && k.length === fs.length) { if (rn && rn[1] === p - 1) rn[1] = p; else { flush(); rn = [p, p]; } }
        else { flush(); k.forEach((f) => parts.push(f.dataset.label)); }
      });
      flush();
      const kept = frames.filter((f) => f.classList.contains('is-kept'));
      $('#keep-str').textContent = parts.join(',');
      const mb = kept.reduce((a, f) => a + (f.dataset.kind === 'p' ? 2.1 : 9.4), 0);
      $('#files-line').textContent = `files: ${kept.length} new, 0 had, 0 failed, ${mb.toFixed(1)}MB`;
      const tree = $('#tree'); tree.textContent = '';
      kept.forEach((f) => {
        const line = document.createElement('span'); line.className = 't-line';
        const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = 'saved';
        line.append(ok, ` x-media/${f.dataset.file}`); tree.append(line);
      });
    }
  }

  // ---- hero run. Each pointer loops: enter, grab, drag along its lane, flick the card into the
  // terminal, hop, leave. Every pointer starts on its still frame (the no-JS picture), runs three
  // cycles and stops on that same frame, so the run ends where JS-off and reduced motion begin.
  const run = $('.run');
  // keep only whole entries in the terminal, newest at the bottom (runs with or without motion)
  const fitBox = run && $('.term-lines', run);
  function fitLines() {
    if (!fitBox) return;
    // hide (never delete) the oldest entries until the newest fit; recomputed from all on every call
    const items = [...fitBox.children];
    while (items.length > 40) items.shift().remove();
    items.forEach((el) => { el.hidden = false; });
    // the log fills from the top under the header; once full, the oldest entries scroll off the top
    for (const el of items.slice(0, -1)) { if (fitBox.scrollHeight <= fitBox.clientHeight + 1) break; el.hidden = true; }
  }
  fitLines();
  addEventListener('resize', fitLines);
  if (!run || !motion) return;
  const lanesEl = $('.lanes', run);
  const cards = JSON.parse(lanesEl.dataset.cards);
  const term = $('.term', run), linesBox = $('.term-lines', run), counts = $$('.term-foot .count', run), replay = $('.replay', run);
  const CYCLES = 3;
  // Cycle: run left to the lane's start (tip leads), grab, haul right (braced drag pose), flick into
  // the terminal, celebrate, run back. Masters are never mirrored.
  const GRAB = 380, FLICK = 240, CHEER = 440, LAUNCH = 90, STRIDE = 85;
  const ease = (u) => (1 - Math.cos(Math.PI * u)) / 2;
  const unease = (p) => Math.acos(1 - 2 * p) / Math.PI;

  const actors = $$('.lane', lanesEl).map((lane, i) => {
    const el = $('.actor', lane);
    const D = Math.round(+lane.dataset.s * 210);   // haul time follows the job's real pace
    const B = Math.round(D * 0.5);                 // running back is quicker
    const g = B, a = g + GRAB, b = a + D, c = b + FLICK;
    const T = c + CHEER;
    const pose = el.dataset.pose, p = parseFloat(el.style.getPropertyValue('--p'));
    const phi = pose.startsWith('run') ? (1 - p) * B : pose === 'grab' ? g + GRAB / 2 : pose === 'drag' ? a + unease(p) * D : pose === 'flick' ? b + LAUNCH / 2 : c + CHEER / 2;
    return { i, lane, el, card: $('.card', el), img: $('.card img', el), D, B, g, a, b, c, T, phi, still: { pose, p }, k: 0, done: false, lastAbs: phi };
  });

  const active = () => actors.filter((x) => x.lane.offsetParent !== null);
  let flights = 0, totalFlights = 0;
  const setCounts = () => {
    const k = totalFlights ? flights / totalFlights : 1;
    counts.forEach((el) => { el.textContent = Math.round(+el.dataset.to * k); });
  };

  function frame(x, t) {
    // t = time inside the cycle
    const { g, a, b, c, D, B } = x;
    let pose, p, y = 0, card = true;
    if (t < g) { pose = `run-${1 + (Math.floor(t / STRIDE) % 4)}`; p = 1 - t / B; card = false; }
    else if (t < a) { pose = 'grab'; p = 0; y = t < g + 120 ? -4 * Math.sin(((t - g) / 120) * Math.PI) : 0; }
    else if (t < b) { pose = 'drag'; p = ease((t - a) / D); y = -2 * (Math.floor(t / 110) % 2); }
    else if (t < c) { pose = 'flick'; p = 1; card = t - b < LAUNCH; }
    else { pose = 'celebrate'; p = 1; card = false; y = -10 * Math.sin(((t - c) / CHEER) * Math.PI); }
    x.el.dataset.pose = pose;
    x.el.style.setProperty('--p', p.toFixed(4));
    x.el.style.translate = y ? `0 ${y.toFixed(1)}px` : '';
    x.el.classList.toggle('no-card', !card);
  }

  function settle(x) {
    x.el.dataset.pose = x.still.pose; x.el.style.setProperty('--p', x.still.p);
    x.el.style.opacity = ''; x.el.style.translate = ''; x.el.classList.remove('no-card');
    x.img.src = `assets/samples/${cards[x.i][0][0]}.webp`;
  }

  function printLine(file) {
    const s = document.createElement('span'); s.className = 'tl new';
    const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = 'saved';
    const cut = file.lastIndexOf('/') + 1;
    s.append(ok, ` ${file.slice(cut)}`); linesBox.append(s);
    fitLines();
    term.classList.add('hit'); setTimeout(() => term.classList.remove('hit'), 140);
  }

  function launch(x, file) {
    const rr = run.getBoundingClientRect();
    const cr = x.card.getBoundingClientRect();
    const tr = $('.term-lines', run).getBoundingClientRect();
    const lr = lanesEl.getBoundingClientRect();
    const sx = cr.left + cr.width / 2 - rr.left, sy = cr.top + cr.height / 2 - rr.top;
    const side = tr.left >= lr.right - 4;
    const tx = side ? tr.left - rr.left + 28 : tr.left - rr.left + 40 + Math.random() * (tr.width * 0.5);
    const ty = side ? Math.min(Math.max(sy + 30, tr.top - rr.top + 20), tr.bottom - rr.top - 20) : tr.top - rr.top + 24;
    const w = x.card.offsetWidth, h = x.card.offsetHeight;
    const fly = document.createElement('div'); fly.className = 'fly'; fly.setAttribute('aria-hidden', 'true');
    const clone = x.card.cloneNode(true); clone.style.fontSize = getComputedStyle(x.card).fontSize;
    fly.append(clone); fly.style.left = `${sx - w / 2}px`; fly.style.top = `${sy - h / 2}px`; fly.style.width = `${w}px`;
    run.append(fly);
    const arc = Math.max(60, Math.abs(tx - sx) * 0.5);
    const kf = [0, 0.2, 0.4, 0.6, 0.8, 1].map((u) => ({
      offset: u,
      transform: `translate(${(tx - sx) * u}px, ${(ty - sy) * u - arc * 4 * u * (1 - u)}px) rotate(${24 + 340 * u}deg) scale(${1 - 0.6 * u})`,
      opacity: u < 0.85 ? 1 : 0,
    }));
    const anim = fly.animate(kf, { duration: 520, easing: 'cubic-bezier(.3,.1,.6,1)', fill: 'forwards' });
    anim.onfinish = () => { fly.remove(); printLine(file); flights++; setCounts(); };
  }

  let elapsed = 0, last = 0, visible = false, raf = 0, running = false;
  function tick(now) {
    raf = 0;
    if (!running) return;
    const dt = last ? Math.min(64, now - last) : 16; last = now;
    elapsed += dt;
    let left = 0;
    active().forEach((x) => {
      if (x.done) return;
      const end = x.phi + CYCLES * x.T;
      const abs = Math.min(x.phi + elapsed, end);
      // flights and card changes crossed since the last frame
      const prevCycle = Math.floor(x.lastAbs / x.T), cycle = Math.floor(abs / x.T);
      if (cycle !== prevCycle) { x.k++; x.img.src = `assets/samples/${cards[x.i][x.k % cards[x.i].length][0]}.webp`; }
      for (let n = Math.floor((x.lastAbs - x.b - LAUNCH) / x.T) + 1; n * x.T + x.b + LAUNCH <= abs; n++) {
        if (n * x.T + x.b + LAUNCH > x.lastAbs) launch(x, cards[x.i][x.k % cards[x.i].length][1]);
      }
      x.lastAbs = abs;
      if (abs >= end) { x.done = true; settle(x); return; }
      left++;
      frame(x, abs % x.T);
    });
    if (!left) { running = false; replay.hidden = false; run.removeAttribute('aria-busy'); return; }
    if (visible) raf = requestAnimationFrame(tick);
  }
  function start() {
    elapsed = 0; last = 0; flights = 0;
    const act = active(); totalFlights = act.length * CYCLES;
    act.forEach((x) => { x.done = false; x.k = 0; x.lastAbs = x.phi; });
    linesBox.textContent = ''; setCounts();
    replay.hidden = true; running = true;
    run.setAttribute('aria-busy', 'true');
    if (visible && !raf) raf = requestAnimationFrame(tick);
  }
  replay.addEventListener('click', () => { start(); });
  // motion visitors start from an empty terminal at 0, not from the end state
  linesBox.textContent = ''; flights = 0; totalFlights = 1; setCounts();
  const io = new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting;
    if (visible && running && !raf) { last = 0; raf = requestAnimationFrame(tick); }
  }, { threshold: 0.15 });
  io.observe(run);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) last = 0; });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(start, 450));
})();

// Launch film: the poster and a link to the MP4 are the base page (no JS, reduced motion).
// With motion allowed, the video element takes the poster's place and the link plays it in place.
(() => {
  if (!document.documentElement.classList.contains('motion')) return;
  const frame = document.querySelector('[data-film]'); if (!frame) return;
  const video = frame.querySelector('video'); const play = document.querySelector('.film-play');
  video.hidden = false;
  if (play) play.addEventListener('click', (e) => {
    e.preventDefault(); video.scrollIntoView({ block: 'center', behavior: 'auto' });
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  });
})();

// Open the credits list when a link points at it.
(() => {
  const open = () => { if (location.hash === '#credits') { const el = document.getElementById('credits'); if (el) el.open = true; } };
  addEventListener('hashchange', open); open();
})();
