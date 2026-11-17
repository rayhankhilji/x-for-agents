// Riffler home: progressive enhancement only. Without this file the page is complete and still.
(() => {
  const d = document.documentElement;
  const motion = d.classList.contains('motion');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- copy buttons
  $$('[data-copy-target]').forEach((b) => {
    const label = b.textContent;
    b.addEventListener('click', async () => {
      const text = document.getElementById(b.dataset.copyTarget).textContent.trim();
      try { await navigator.clipboard.writeText(text); }
      catch {
        const r = document.createRange(); r.selectNodeContents(document.getElementById(b.dataset.copyTarget));
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); s.removeAllRanges();
      }
      b.textContent = 'Copied'; b.dataset.done = '';
      setTimeout(() => { b.textContent = label; delete b.dataset.done; }, 1800);
    });
  });

  // ---- top bar rule once the page has scrolled
  const bar = $('.bar');
  const onScroll = () => bar.classList.toggle('is-stuck', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // ---- ring draw-on: centerline path stroked, then the filled art returns
  function drawRing(ring) {
    return new Promise((res) => {
      const p = ring.querySelector('svg + svg path');
      if (!motion || !p) { ring.style.visibility = 'visible'; return res(); }
      const len = Math.ceil(p.getTotalLength());
      p.style.setProperty('--len', len);
      ring.style.visibility = 'visible';
      ring.classList.add('draw');
      setTimeout(() => { ring.classList.remove('draw'); res(); }, 600);
    });
  }

  // ---- client tabs (wide and narrow); the <details> list is the no-JS form
  const clients = $('#clients');
  if (clients) {
    const items = $$('details.client', clients);
    const list = document.createElement('div'); list.className = 'tab-list'; list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Clients');
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
      panel.append($('.client-body', det)); panel.hidden = i !== 0;
      if (det.dataset.mark === 'text') tab.querySelector('.client-mark').style.visibility = 'hidden';
      list.append(tab); panels.append(panel); det.remove();
    });
    const source = $('.source', clients);
    clients.prepend(list); clients.insertBefore(panels, source); clients.classList.add('tabs');
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

  // ---- beat 4: click frames to keep; the row string, the call and the files follow
  const sheet = $('#sheet');
  if (sheet) {
    const frames = $$('.frame', sheet);
    const byPost = new Map();
    frames.forEach((f) => { const p = +f.dataset.post; if (!byPost.has(p)) byPost.set(p, []); byPost.get(p).push(f); });
    const ringOne = $('.frame[data-label="2"] .ring', sheet);
    const tmpl = ringOne ? ringOne.cloneNode(true) : null;
    // the wide ring around 9-12 breaks into single rings as soon as one of them changes
    const splitSpan = () => {
      const span = $('.ring--span', sheet); if (!span) return;
      span.remove();
      frames.filter((f) => ['9', '10', '11', '12'].includes(f.dataset.label) && f.classList.contains('is-kept') && !$('.ring', f))
        .forEach((f) => f.insertBefore(tmpl.cloneNode(true), $('.frame-btn', f)));
    };
    frames.forEach((f) => {
      const btn = $('.frame-btn', f);
      if (!btn) return;
      const toggle = (opts = {}) => {
        if (['9', '10', '11', '12'].includes(f.dataset.label)) splitSpan();
        const on = !f.classList.contains('is-kept');
        f.classList.toggle('is-kept', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-label', `${btn.dataset.name}, ${on ? 'kept' : 'not kept'}`);
        let r = $('.ring', f);
        if (on && !r && tmpl && !opts.byStroke) { r = tmpl.cloneNode(true); f.insertBefore(r, btn); }
        if (r) { if (on) { r.style.display = ''; drawRing(r); } else r.style.display = 'none'; }
        update();
      };
      btn.addEventListener('click', (e) => { if (sheet.dataset.justDrew) { e.preventDefault(); return; } toggle(); });
      f._keep = () => { if (!f.classList.contains('is-kept')) toggle({ byStroke: true }); };
    });

    // ---- draw your keep: drag a loose loop over the sheet; frames whose centre falls inside are kept.
    // The stroke stays as the ring. Click-to-toggle and the buttons stay as the keyboard path.
    const layer = $('.draw-layer', sheet.parentNode);
    const NS = 'http://www.w3.org/2000/svg';
    if (layer && window.PointerEvent) {
      sheet.classList.add('can-draw');
      let pts = null, path = null, id = null;
      const at = (e) => { const b = sheet.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
      const d = (p) => {
        if (p.length < 2) return '';
        let out = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
        for (let i = 1; i < p.length - 1; i++) { const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2]; out += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`; }
        const l = p[p.length - 1]; return out + ` L${l[0].toFixed(1)} ${l[1].toFixed(1)}`;
      };
      const inside = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
      const drop = () => { if (path) path.parentNode.removeChild(path); path = null; pts = null; };
      sheet.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        pts = [at(e)]; id = e.pointerId;
        path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'live'); layer.append(path);
      });
      sheet.addEventListener('pointermove', (e) => {
        if (!pts || e.pointerId !== id) return;
        const p = at(e), q = pts[pts.length - 1];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 3) return;
        pts.push(p);
        if (pts.length === 4) { try { sheet.setPointerCapture(id); } catch (_) {} }
        path.setAttribute('d', d(pts));
      });
      sheet.addEventListener('pointerup', (e) => {
        if (!pts || e.pointerId !== id) return;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const big = pts.length > 6 && Math.max(...xs) - Math.min(...xs) > 24 && Math.max(...ys) - Math.min(...ys) > 24;
        if (!big) { drop(); return; } // a click: the frame button handles it
        path.setAttribute('class', '');
        const b = sheet.getBoundingClientRect(); let n = 0;
        frames.forEach((f) => {
          if (getComputedStyle(f).display === 'none') return;
          const r = f.getBoundingClientRect();
          if (inside(r.left - b.left + r.width / 2, r.top - b.top + r.height / 2, pts)) { f._keep(); n++; }
        });
        if (!n) drop();
        else { path = null; pts = null; const live = $('#sheet-live'); if (live) live.textContent = `Ring drawn. Row string now ${$('#keep-str').textContent}.`; }
        sheet.dataset.justDrew = '1'; setTimeout(() => { delete sheet.dataset.justDrew; }, 0);
      });
      sheet.addEventListener('pointercancel', drop);
    }
    const clear = $('#sheet-clear');
    if (clear) clear.addEventListener('click', () => {
      if (layer) layer.textContent = '';
      $$('.ring--span', sheet).forEach((r) => r.parentNode.removeChild(r));
      frames.forEach((f) => {
        if (!f.classList.contains('is-kept')) return;
        f.classList.toggle('is-kept', false);
        const btn = $('.frame-btn', f); btn.setAttribute('aria-pressed', 'false'); btn.setAttribute('aria-label', `${btn.dataset.name}, not kept`);
        const r = $('.ring', f); if (r) r.style.display = 'none';
      });
      update();
    });
    function update() {
      // a post with every item kept is written as its number; consecutive whole posts become a range
      const parts = []; let run = null;
      const flush = () => { if (run) { parts.push(run[0] === run[1] ? `${run[0]}` : `${run[0]}-${run[1]}`); run = null; } };
      [...byPost.keys()].sort((a, b) => a - b).forEach((p) => {
        const fs = byPost.get(p); const k = fs.filter((f) => f.classList.contains('is-kept'));
        if (k.length && k.length === fs.length) { if (run && run[1] === p - 1) run[1] = p; else { flush(); run = [p, p]; } }
        else { flush(); k.forEach((f) => parts.push(f.dataset.label)); }
      });
      flush();
      const kept = frames.filter((f) => f.classList.contains('is-kept'));
      $('#keep-str').textContent = parts.join(',');
      const mb = kept.reduce((a, f) => a + (f.dataset.kind === 'p' ? 2.1 : 9.4), 0);
      $('#files-line').textContent = `files: ${kept.length} new, 0 had, 0 failed, ${mb.toFixed(1)}MB`;
      const tree = $('#tree'); tree.textContent = '';
      kept.forEach((f) => {
        const [dir, file] = f.dataset.file.split('/');
        const line = document.createElement('span'); line.className = 't-line';
        const dd = document.createElement('span'); dd.className = 't-dir'; dd.textContent = `x-media/${dir}/`;
        line.append(dd, file); tree.append(line);
      });
    }
  }

  // ---- beat 2: lanes run at each job's real pace while on screen, then stop at the job's end
  const lanesEl = $('.lanes');
  if (lanesEl && motion) {
    const data = JSON.parse(lanesEl.dataset.lanes);
    const lanes = $$('.lane', lanesEl);
    let started = false;
    const io = new IntersectionObserver((es) => {
      if (started || !es.some((e) => e.isIntersecting)) return;
      started = true; io.disconnect();
      lanesEl.classList.add('running');
      const runners = $$('.runner', lanesEl); let fr = 'a';
      const legs = runners.length ? setInterval(() => { fr = fr === 'a' ? 'b' : 'a'; runners.forEach((r) => { r.dataset.f = fr; }); }, 140) : 0;
      let done = 0;
      lanes.forEach((lane, i) => {
        const ol = $('.lane-rows', lane); ol.textContent = '';
        const rows = data[i]; const step = (+lane.dataset.s * 1000) / rows.length;
        let n = 0;
        const tick = () => {
          const li = document.createElement('li'); li.textContent = rows[n++]; ol.append(li);
          while (ol.children.length > 15) ol.firstChild.remove();
          if (n < rows.length) setTimeout(tick, step);
          else { lane.classList.add('ended'); if (++done === lanes.length) { lanesEl.classList.remove('running'); clearInterval(legs); } }
        };
        tick();
      });
    }, { threshold: 0.35 });
    io.observe(lanesEl);
  }

  // ---- beat 1: lanes run, frames land, the total prints, the ring is drawn. Once.
  const hero = $('.sheet-hero');
  if (hero && hero.classList.contains('run')) {
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      hero.classList.remove('run', 'fill'); hero.classList.add('done');
      $$('.ring', hero).forEach((r) => { r.classList.remove('draw'); r.style.visibility = ''; });
      $$('.count', hero).forEach((c) => { c.textContent = c.dataset.to; });
      $$('.keep-note, .total', hero).forEach((e) => { e.style.visibility = ''; });
      ['wheel', 'keydown', 'pointerdown', 'touchstart'].forEach((e) => removeEventListener(e, finish));
    };
    ['wheel', 'keydown', 'pointerdown', 'touchstart'].forEach((e) => addEventListener(e, finish, { passive: true, once: true }));

    (async () => {
      const lanesBox = $('.hero-lanes', hero);
      const data = lanesEl ? JSON.parse(lanesEl.dataset.lanes) : [];
      const cols = data.map(() => { const ol = document.createElement('ol'); lanesBox.append(ol); return ol; });
      let t = 0;
      const timer = setInterval(() => {
        cols.forEach((ol, i) => {
          if ((t + i) % (1 + (i % 3)) !== 0) return; // each tab answers at its own rate
          const li = document.createElement('li'); li.textContent = data[i][(t + i * 3) % 60]; ol.append(li);
          while (ol.children.length > 24) ol.firstChild.remove();
        });
        t++;
      }, 40);
      await wait(1500); clearInterval(timer);
      if (finished) return;
      hero.classList.add('fill'); hero.classList.remove('run');
      $$('.ring, .keep-note, .total', hero).forEach((e) => (e.style.visibility = 'hidden'));
      const frames = $$('.frame', hero);
      const counts = $$('.total .count', hero);
      $('.total', hero).style.visibility = 'visible';
      for (let i = 0; i < frames.length && !finished; i += 2) {
        frames[i].classList.add('on'); if (frames[i + 1]) frames[i + 1].classList.add('on');
        const k = Math.min(1, (i + 2) / frames.length);
        counts.forEach((c) => { c.textContent = Math.round(+c.dataset.to * k); });
        await wait(16);
      }
      if (finished) return;
      hero.classList.remove('fill');
      await wait(250);
      for (const r of $$('.ring', hero).filter((x) => getComputedStyle(x).display !== 'none')) { if (finished) return; await drawRing(r); }
      $('.keep-note', hero).style.visibility = 'visible';
      finish();
    })();
  }
})();

// Open the credits list when a link points at it.
(() => {
  const open = () => { if (location.hash === '#credits') { const d = document.getElementById('credits'); if (d) d.open = true; } };
  addEventListener('hashchange', open); open();
})();

// Launch film: the poster is a native lazy image with a link to the file (works with JS off).
// Near the viewport the <video> is built (preload none). It autoplays muted while at least half in view,
// unless the visitor prefers reduced motion; then the poster stays with the play button.
(() => {
  const box = document.querySelector('[data-film]');
  if (!box || !('IntersectionObserver' in window)) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let video = null;
  const build = () => {
    video = document.createElement('video');
    Object.assign(video, { muted: true, loop: true, playsInline: true, preload: 'none' });
    video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('loop', ''); video.setAttribute('preload', 'none');
    video.poster = box.querySelector('.film-poster').currentSrc || box.querySelector('.film-poster').src;
    video.setAttribute('aria-label', 'Launch film, 38 seconds, no sound: a run from one sentence to the files in the repo');
    for (const [type, key] of [['video/webm', 'webm'], ['video/mp4', 'mp4']]) { const s = document.createElement('source'); s.src = box.dataset[key]; s.type = type; video.append(s); }
    box.prepend(video);
  };
  const play = box.querySelector('.film-play');
  const start = (e) => {
    if (e) e.preventDefault();
    if (!video) build();
    video.controls = true; play.hidden = true;
    video.play().catch(() => { play.hidden = false; });
  };
  play.addEventListener('click', start);
  const near = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { if (!video) build(); near.disconnect(); } }, { rootMargin: '600px 0px' });
  near.observe(box);
  if (reduce) return;
  const seen = new IntersectionObserver((es) => {
    const e = es[es.length - 1];
    if (e.intersectionRatio >= 0.5) start();
    else if (video && !video.paused) video.pause();
  }, { threshold: [0, 0.5] });
  seen.observe(box);
})();
