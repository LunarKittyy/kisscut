// UI, state and glue.
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const PRESETS = { A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8], '4 x 6 in': [101.6, 152.4] };
  const MODES = [
    ['follow', 'Outline', 'Hugs the artwork, with rounded corners. Separate pieces are joined into one shape.'],
    ['hull', 'Hull', 'Wraps the whole artwork in its convex outline. Good for spiky or loose shapes.'],
    ['rrect', 'Rect', 'A rounded rectangle around the artwork.'],
    ['circle', 'Circle', 'The smallest circle that holds the artwork.'],
    ['hex', 'Hex', 'A rounded hexagon around the artwork.'],
  ];
  const MODE_ROUND = { follow: 5, hull: 5, rrect: 8, circle: 0, hex: 9 };

  let state = freshState();
  let sheet = null;          // last packed sheet
  let sheetInfo = null;      // { ms }
  let stale = false;
  let packing = false, cancelPack = false;
  let zoom = 1;
  const itemCache = new Map();
  const cutCache = new Map();

  function freshState() {
    return {
      page: { preset: 'A4', w: 210, h: 297, landscape: false, margin: 8, gap: 3 },
      cut: { show: true, color: '#8a8a8a', width: 0.25, dash: false },
      base: { color: '#ffffff' },
      pack: { tries: 24, seed: 43, grid: 2, rotate: false, fill: true },
      out: { dpi: 600 },
      designs: [],
      selected: null,
      tab: 'stickers',
    };
  }

  function newDesign(name, dataUrl, extra = {}) {
    const d = {
      id: 'd' + Math.random().toString(36).slice(2, 8), name, dataUrl, whiteBg: false, enabled: true,
      sizes: '60, 40', filler: 30, tiny: 0, bias: 0,
      shape: { mode: 'follow', border: 3, rounding: 5, smooth: 0 },
      outline: { on: false, color: '#000000', width: 0.4, opacity: 0.18 },
      ...extra,
    };
    Object.defineProperty(d, 'rt', { value: null, writable: true, enumerable: false });
    return d;
  }

  const dmap = () => new Map(state.designs.map((d) => [d.id, d]));
  const selected = () => state.designs.find((d) => d.id === state.selected) || null;

  // ---------- tiny DOM helper ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'value' || k === 'checked') el[k] = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
  }

  // ---------- persistence ----------
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('kisscut', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); },
  };
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { idb.set('project', JSON.parse(JSON.stringify(state))).catch(() => {}); } catch (e) { /* storage unavailable */ } }, 400);
  }

  // ---------- image loading ----------
  const b64 = (str) => { const bytes = new TextEncoder().encode(str); let s = ''; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };

  function normalizeSvg(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (doc.querySelector('parsererror') || svg.nodeName.toLowerCase() !== 'svg') throw new Error('That does not look like a valid SVG.');
    svg.querySelectorAll('script').forEach((n) => n.remove());
    let vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some((n) => !isFinite(n))) {
      const w = parseFloat(svg.getAttribute('width')), hh = parseFloat(svg.getAttribute('height'));
      if (!w || !hh) throw new Error('This SVG has no viewBox or size.');
      vb = [0, 0, w, hh];
      svg.setAttribute('viewBox', vb.join(' '));
    }
    const k = 1000 / Math.max(vb[2], vb[3]);
    svg.setAttribute('width', String(vb[2] * k));
    svg.setAttribute('height', String(vb[3] * k));
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(svg);
  }

  const readAs = (file, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r[how](file); });

  async function fileToData(file) {
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    if (isSvg) return 'data:image/svg+xml;base64,' + b64(normalizeSvg(await readAs(file, 'readAsText')));
    if (!file.type.startsWith('image/')) throw new Error(file.name + ' is not an image.');
    const url = await readAs(file, 'readAsDataURL');
    const img = new Image();
    img.src = url;
    await img.decode();
    const m = Math.max(img.naturalWidth, img.naturalHeight);
    if (m <= 2600) return url;
    const c = Geo.cnv(Math.round((img.naturalWidth * 2600) / m), Math.round((img.naturalHeight * 2600) / m));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  async function loadRuntime(d) {
    const img = new Image();
    img.src = d.dataUrl;
    await img.decode();
    const natW = img.naturalWidth, natH = img.naturalHeight;
    const a = Shape.analyze(img, natW, natH, d.whiteBg);
    d.rt = { img, natW, natH, dataUrl: d.dataUrl, ...a };
  }

  const prettyName = (n) => n.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';

  async function addFiles(files) {
    let added = 0;
    for (const f of files) {
      try {
        const d = newDesign(prettyName(f.name), await fileToData(f));
        await loadRuntime(d);
        state.designs.push(d);
        state.selected = d.id;
        added++;
      } catch (e) { toast(e.message || 'Could not read ' + f.name); }
    }
    if (!added) return;
    state.tab = 'stickers';
    renderAll();
    save();
    runPack();
  }

  async function addSamples() {
    const tweaks = {
      Star: { sizes: '70, 46', filler: 32 }, Heart: { sizes: '64, 42', filler: 30, shape: { mode: 'follow', border: 3, rounding: 6, smooth: 4 } },
      Bolt: { sizes: '60, 38', filler: 28, shape: { mode: 'hex', border: 3, rounding: 9, smooth: 0 } }, 'Three dots': { sizes: '80, 52', filler: 40 },
    };
    for (const s of window.SAMPLES) {
      const d = newDesign(s.name, 'data:image/svg+xml;base64,' + b64(normalizeSvg(s.svg)), tweaks[s.name]);
      await loadRuntime(d);
      state.designs.push(d);
      state.selected = d.id;
    }
    renderAll();
    save();
    runPack();
  }

  // ---------- derived config ----------
  function pageDims() {
    const p = state.page;
    let [w, hh] = p.preset === 'Custom' ? [p.w, p.h] : PRESETS[p.preset];
    if (p.landscape) [w, hh] = [hh, w];
    return { w, h: hh };
  }

  function parseSizes(str, max) {
    const out = [];
    for (const tok of String(str).split(/[,;\s]+/).filter(Boolean)) {
      const m = tok.match(/^(\d+)[x×*]([\d.]+)$/i);
      const n = m ? +m[1] : 1, w = m ? parseFloat(m[2]) : parseFloat(tok);
      if (!isFinite(w) || w < 3) continue;
      for (let i = 0; i < Math.min(n, 60); i++) out.push(Math.min(w, max));
    }
    return out;
  }

  function markStale() {
    stale = true;
    $('#btnPack').classList.add('stale');
    updateStatus();
  }

  // ---------- packing ----------
  function getCut(d, W) {
    const key = [d.id, W, d.whiteBg, d.shape.mode, d.shape.border, d.shape.rounding, d.shape.smooth, d.rt.crop.w].join('|');
    if (!cutCache.has(key)) {
      if (cutCache.size > 300) cutCache.clear();
      cutCache.set(key, Shape.buildCut(d.rt, W, d.shape));
    }
    return cutCache.get(key);
  }

  function getItem(d, W, cfg) {
    const key = [d.id, W, d.whiteBg, d.shape.mode, d.shape.border, d.shape.rounding, d.shape.smooth, cfg.grid, cfg.gap, cfg.rotate].join('|');
    if (!itemCache.has(key)) {
      if (itemCache.size > 200) itemCache.clear();
      itemCache.set(key, Pack.makeItem(d.id, W, d.rt.aspect, getCut(d, W), cfg));
    }
    return itemCache.get(key);
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function runPack() {
    const btn = $('#btnPack');
    if (packing) { cancelPack = true; return; }
    const ds = state.designs.filter((d) => d.enabled && d.rt);
    if (!ds.length) { toast('Add or enable at least one design first.'); return; }
    const { w, h: hh } = pageDims();
    const cfg = { pageW: w, pageH: hh, margin: state.page.margin, gap: state.page.gap, ...state.pack };
    const maxW = Math.min(w, hh) - 2 * cfg.margin;
    if (maxW < 10) { toast('Margins leave no room on the page.'); return; }
    packing = true; cancelPack = false;
    $('#paper').classList.add('busy');
    btn.textContent = 'Preparing shapes...';
    try {
      const plan = { required: [], tiers: [{}, {}], bias: {}, designIds: ds.map((d) => d.id) };
      for (const d of ds) {
        for (const sz of parseSizes(d.sizes, maxW)) { plan.required.push(getItem(d, sz, cfg)); await tick(); }
        if (d.filler >= 3) plan.tiers[0][d.id] = getItem(d, Math.min(d.filler, maxW), cfg);
        if (d.tiny >= 3) plan.tiers[1][d.id] = getItem(d, Math.min(d.tiny, maxW), cfg);
        plan.bias[d.id] = d.bias;
        await tick();
      }
      if (!plan.required.length && !plan.tiers.some((t) => Object.keys(t).length)) { toast('Nothing to place: give a design at least one size.'); return; }
      const result = await Pack.pack(plan, cfg, {
        cancelled: () => cancelPack,
        progress: (i, n) => { btn.textContent = `Packing ${i}/${n} (stop)`; },
      });
      if (!result) return;
      sheet = Pack.toSheet(result, cfg);
      sheetInfo = { ms: result.ms };
      stale = false;
      btn.classList.remove('stale');
    } catch (e) {
      console.error(e);
      toast('Packing failed: ' + e.message);
    } finally {
      packing = false;
      btn.textContent = 'Pack sheet';
      $('#paper').classList.remove('busy');
    }
    renderSheet();
    updateCounts();
    updateStatus();
  }

  // ---------- sheet view ----------
  const styleOf = () => ({ cut: state.cut, base: state.base, paper: { color: '#ffffff' } });

  function renderSheet() {
    const paper = $('#paper');
    $('#empty').hidden = state.designs.length > 0;
    if (!sheet) { paper.innerHTML = ''; paper.hidden = true; return; }
    paper.hidden = false;
    paper.innerHTML = Render.buildSVG(sheet, dmap(), styleOf());
    paper.querySelectorAll('.sticker').forEach((g) => {
      g.addEventListener('click', () => { state.selected = g.dataset.design; state.tab = 'stickers'; renderPanes(); markSel(); });
    });
    markSel();
    fit();
  }

  function markSel() {
    document.querySelectorAll('.paper .sticker').forEach((g) => g.classList.toggle('sel', g.dataset.design === state.selected));
  }

  function fit() {
    if (!sheet) return;
    const sc = $('#scroll');
    const availW = sc.clientWidth - 56, availH = sc.clientHeight - 56;
    const k = Math.min(availW / sheet.pageW, availH / sheet.pageH) * zoom;
    const paper = $('#paper');
    paper.style.width = Math.max(80, sheet.pageW * k) + 'px';
  }

  function rerender() {
    if (sheet) renderSheet();
    save();
  }

  function updateStatus() {
    const el = $('#status');
    el.textContent = '';
    if (!sheet) { el.append(state.designs.length ? 'Ready to pack.' : 'No designs yet.'); return; }
    const covered = sheet.stickers.reduce((s, st) => {
      let a = 0;
      for (let i = 0, n = st.ring.length; i < n; i++) { const p = st.ring[i], q = st.ring[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
      return s + Math.abs(a / 2);
    }, 0) / (sheet.pageW * sheet.pageH);
    el.append(h('b', {}, String(sheet.stickers.length)), ' stickers  ·  ', h('b', {}, Math.round(covered * 100) + '%'), ' of the page', sheetInfo ? `  ·  ${(sheetInfo.ms / 1000).toFixed(1)}s` : '');
    if (sheet.missing.length) {
      const dm = dmap();
      el.append('  ·  ', h('span', { class: 'warn' }, `${sheet.missing.length} did not fit (${sheet.missing.map((m) => (dm.get(m.designId)?.name || '?') + ' ' + m.width + 'mm').join(', ')})`));
    }
    if (stale) el.append('  ·  ', h('span', { class: 'stale' }, 'settings changed, pack again'));
  }

  function updateCounts() {
    const counts = {};
    if (sheet) sheet.stickers.forEach((s) => (counts[s.designId] = (counts[s.designId] || 0) + 1));
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = sheet ? '×' + (counts[el.dataset.count] || 0) : ''; });
  }

  // ---------- controls ----------
  function changed(kind) {
    if (kind === 'layout') markStale(); else rerender();
    save();
  }

  function numRow(label, obj, key, o = {}) {
    const { min = 0, max = 100, step = 1, unit = '', kind = 'layout', slider = true, after } = o;
    const num = h('input', { type: 'number', min, max, step, value: obj[key], 'aria-label': label });
    const rng = slider ? h('input', { type: 'range', min, max, step, value: obj[key], 'aria-label': label + ' slider' }) : null;
    const apply = (v) => { obj[key] = v; changed(kind); if (after) after(v); };
    if (rng) rng.addEventListener('input', () => { num.value = rng.value; apply(+rng.value); });
    num.addEventListener('input', () => {
      const v = parseFloat(num.value);
      if (!isFinite(v) || v < min || v > max) return;
      if (rng) rng.value = v;
      apply(v);
    });
    num.addEventListener('change', () => {
      const v = clamp(parseFloat(num.value) || min, min, max);
      num.value = v; if (rng) rng.value = v; apply(v);
    });
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, rng, num, h('span', { class: 'unit' }, unit)));
  }

  function toggleRow(label, obj, key, o = {}) {
    const inp = h('input', { type: 'checkbox', checked: !!obj[key], 'aria-label': label });
    inp.addEventListener('change', () => { obj[key] = inp.checked; changed(o.kind || 'layout'); if (o.after) o.after(inp.checked); });
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, h('span', { class: 'switch' }, inp, h('i'))));
  }

  function colorRow(label, obj, key, o = {}) {
    const inp = h('input', { type: 'color', value: obj[key], 'aria-label': label });
    inp.addEventListener('input', () => { obj[key] = inp.value; changed(o.kind || 'style'); if (o.after) o.after(); });
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, inp));
  }

  function selectRow(label, obj, key, options, o = {}) {
    const sel = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, t)));
    sel.addEventListener('change', () => { const v = isNaN(+sel.value) ? sel.value : +sel.value; obj[key] = v; changed(o.kind || 'layout'); if (o.after) o.after(v); });
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, sel));
  }

  function segRow(label, current, options, onPick) {
    const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    options.forEach(([v, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(current === v) }, t);
      b.addEventListener('click', () => { onPick(v); wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
      wrap.append(b);
    });
    return wrap;
  }

  // ---------- panes ----------
  function renderTabs() {
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    ['stickers', 'sheet', 'export'].forEach((t) => ($('#pane-' + t).hidden = state.tab !== t));
  }

  function renderPanes() {
    renderTabs();
    renderStickersPane();
    renderSheetPane();
    renderExportPane();
    updateCounts();
  }

  function renderAll() {
    renderPanes();
    renderSheet();
    updateStatus();
  }

  function renderStickersPane() {
    const pane = $('#pane-stickers');
    const keepScroll = pane.scrollTop;
    pane.textContent = '';
    const list = h('div', { class: 'dlist', role: 'listbox', 'aria-label': 'Designs' });
    state.designs.forEach((d) => {
      const row = h('div', { class: 'drow' + (d.enabled ? '' : ' off'), role: 'option', tabindex: '0', 'aria-current': String(d.id === state.selected) },
        h('div', { class: 'thumb' }, h('img', { src: d.dataUrl, alt: '' })),
        h('div', { style: 'min-width:0' }, h('div', { class: 'dname' }, d.name), h('div', { class: 'dmeta' }, d.sizes || 'no sizes')),
        h('div', { class: 'dcount', 'data-count': d.id }));
      row.addEventListener('click', () => { state.selected = d.id; renderStickersPane(); markSel(); updateCounts(); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
      list.append(row);
    });
    const add = h('div', { class: 'addrow' },
      h('button', { class: 'btn', type: 'button', onclick: () => $('#file').click() }, 'Add files'),
      state.designs.length ? null : h('button', { class: 'btn', type: 'button', onclick: addSamples }, 'Try examples'));
    pane.append(h('div', { class: 'sect' }, h('h3', {}, 'Designs', h('span', { class: 'mono', style: 'letter-spacing:0;text-transform:none' }, state.designs.length || '')), state.designs.length ? list : h('p', { class: 'hint' }, 'Drop SVG or image files anywhere on the page.'), add));

    const d = selected();
    if (!d) return;
    pane.append(inspector(d));
    pane.scrollTop = keepScroll;
  }

  function inspector(d) {
    const root = h('div');
    const nameInp = h('input', { type: 'text', value: d.name, 'aria-label': 'Design name' });
    nameInp.addEventListener('input', () => {
      d.name = nameInp.value; save();
      document.querySelectorAll('.drow[aria-current="true"] .dname').forEach((e) => (e.textContent = d.name || 'Untitled'));
    });
    const replace = h('button', { class: 'btn small', type: 'button', onclick: () => replaceFile(d) }, 'Replace');
    const dup = h('button', { class: 'btn small', type: 'button', onclick: () => duplicate(d) }, 'Duplicate');
    const rm = h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => removeDesign(d) }, 'Remove');
    root.append(h('div', { class: 'sect' },
      h('div', { class: 'inspector-head' }, h('div', { class: 'thumb' }, h('img', { src: d.dataUrl, alt: '' })), nameInp),
      h('div', { class: 'tools' }, replace, dup, rm)));

    // sizes
    const meta = h('p', { class: 'hint' });
    const sizesInp = h('input', { type: 'text', value: d.sizes, placeholder: '70, 45, 2x30', 'aria-label': 'Sticker sizes' });
    const setMeta = () => {
      const n = parseSizes(d.sizes, 9999).length;
      meta.textContent = n ? `${n} sticker${n === 1 ? '' : 's'} guaranteed. Widths in mm, 2x30 means two at 30.` : 'Nothing guaranteed, this design only appears as filler.';
    };
    setMeta();
    sizesInp.addEventListener('input', () => {
      d.sizes = sizesInp.value; setMeta(); markStale(); save();
      document.querySelectorAll('.drow[aria-current="true"] .dmeta').forEach((e) => (e.textContent = d.sizes || 'no sizes'));
    });
    const en = toggleRow('Include in sheet', d, 'enabled', { after: () => renderStickersPane() });
    root.append(h('div', { class: 'sect' }, h('h3', {}, 'Sizes'),
      h('div', { class: 'row full' }, h('label', {}, 'Guaranteed widths (mm)'), h('div', { class: 'ctl' }, sizesInp)), meta,
      h('div', { style: 'height:12px' }),
      numRow('Filler width', d, 'filler', { min: 0, max: 200, slider: false, unit: 'mm' }),
      numRow('Tiny filler width', d, 'tiny', { min: 0, max: 200, slider: false, unit: 'mm' }),
      numRow('Filler weight', d, 'bias', { min: -5, max: 5, step: 1 }),
      h('p', { class: 'hint', style: 'margin-top:-4px' }, 'Leftover space is filled with filler, then tiny. Weight above 0 gives this design more of it.'),
      h('div', { style: 'height:12px' }), en));

    // cut shape
    const pv = h('div', { id: 'cutpv', style: 'height:150px;background:var(--field);border:1px solid var(--line);border-radius:3px;margin-bottom:12px;display:grid;place-items:center' });
    const modeHint = h('p', { class: 'hint', style: 'margin:-4px 0 12px' }, MODES.find((m) => m[0] === d.shape.mode)[2]);
    const shapeBody = h('div');
    const buildShapeControls = () => {
      shapeBody.textContent = '';
      const m = d.shape.mode;
      const after = () => schedulePreview();
      shapeBody.append(numRow('Border', d.shape, 'border', { min: 0, max: 12, step: 0.1, unit: 'mm', after }));
      if (m !== 'circle') shapeBody.append(numRow(m === 'follow' || m === 'hull' ? 'Corner smoothing' : 'Corner radius', d.shape, 'rounding', { min: 0, max: 40, step: 0.5, unit: '%', after }));
      if (m === 'follow' || m === 'hull') shapeBody.append(numRow('Edge blur', d.shape, 'smooth', { min: 0, max: 15, step: 0.5, unit: '%', after }));
    };
    buildShapeControls();
    const seg = segRow('Cut shape', d.shape.mode, MODES.map(([v, t]) => [v, t]), (v) => {
      d.shape.mode = v; d.shape.rounding = MODE_ROUND[v];
      modeHint.textContent = MODES.find((m) => m[0] === v)[2];
      buildShapeControls(); markStale(); save(); schedulePreview();
    });
    root.append(h('div', { class: 'sect' }, h('h3', {}, 'Cut line'), pv, seg, h('div', { style: 'height:10px' }), modeHint, shapeBody));

    // appearance
    const wb = toggleRow('Treat white as empty', d, 'whiteBg', { kind: 'layout', after: async () => { try { await loadRuntime(d); cutCache.clear(); itemCache.clear(); schedulePreview(); } catch (e) { toast(e.message); } } });
    const olBody = h('div');
    const buildOl = () => {
      olBody.textContent = '';
      if (!d.outline.on) return;
      olBody.append(colorRow('Colour', d.outline, 'color'), numRow('Width', d.outline, 'width', { min: 0.1, max: 3, step: 0.05, unit: 'mm', kind: 'style', after: schedulePreview }), numRow('Strength', d.outline, 'opacity', { min: 0.05, max: 1, step: 0.05, kind: 'style' }));
    };
    buildOl();
    root.append(h('div', { class: 'sect' }, h('h3', {}, 'Artwork'), wb,
      h('p', { class: 'hint', style: 'margin:-4px 0 12px' }, 'For JPGs or images with a solid white background.'),
      toggleRow('Inner outline', d.outline, 'on', { kind: 'style', after: () => { buildOl(); schedulePreview(); } }),
      h('p', { class: 'hint', style: 'margin:-4px 0 12px' }, 'A soft line just inside the edge, so pale artwork stays visible on white paper.'), olBody));

    const dims = h('dl', { class: 'facts' },
      h('dt', {}, 'Source size'), h('dd', {}, `${d.rt.natW} × ${d.rt.natH} px`),
      h('dt', {}, 'Artwork aspect'), h('dd', {}, (d.rt.aspect).toFixed(3)),
      h('dt', {}, 'Outline points'), h('dd', {}, String(d.rt.silhouette.reduce((s, r) => s + r.length, 0))));
    root.append(h('div', { class: 'sect' }, h('h3', {}, 'Source'), dims));

    schedulePreview();
    return root;
  }

  let pvTimer;
  function schedulePreview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(() => {
      const d = selected(), box = $('#cutpv');
      if (!d || !d.rt || !box) return;
      try {
        const W = 40, H = d.rt.aspect * W;
        const ring = getCut(d, W);
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const pad = 2.5, vb = `${(x0 - pad).toFixed(2)} ${(y0 - pad).toFixed(2)} ${(x1 - x0 + 2 * pad).toFixed(2)} ${(y1 - y0 + 2 * pad).toFixed(2)}`;
        const { crop, natW, natH, silhouette } = d.rt;
        const sil = Render.ringD ? silhouette.map((r) => Render.ringD(r)).join('') : '';
        let ol = '';
        if (d.outline.on) ol = `<g transform="scale(${W})"><path d="${sil}" fill="none" stroke="${d.outline.color}" stroke-opacity="${d.outline.opacity}" stroke-width="${(2 * d.outline.width) / W}" clip-path="url(#pvclip)" stroke-linejoin="round"/></g>`;
        box.innerHTML = `<svg viewBox="${vb}" style="width:100%;height:100%"><defs><clipPath id="pvclip"><path d="${sil}" clip-rule="evenodd"/></clipPath></defs><path d="${Render.ringD(ring)}" fill="${state.base.color}"/><svg x="0" y="0" width="${W}" height="${H}" viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}"><image href="${d.dataUrl}" width="${natW}" height="${natH}"/></svg>${ol}<path d="${Render.ringD(ring)}" fill="none" stroke="#e5127f" stroke-width="0.35" stroke-dasharray="1.4 0.9" stroke-linejoin="round"/></svg>`;
      } catch (e) { console.error(e); box.textContent = 'Preview failed'; }
    }, 90);
  }

  async function replaceFile(d) {
    const inp = h('input', { type: 'file', accept: 'image/*,.svg' });
    inp.addEventListener('change', async () => {
      if (!inp.files[0]) return;
      try {
        d.dataUrl = await fileToData(inp.files[0]);
        await loadRuntime(d);
        cutCache.clear(); itemCache.clear();
        renderPanes(); markStale(); save();
      } catch (e) { toast(e.message); }
    });
    inp.click();
  }

  async function duplicate(d) {
    const c = newDesign(d.name + ' copy', d.dataUrl, JSON.parse(JSON.stringify({ ...d, id: undefined, name: undefined, dataUrl: undefined })));
    c.id = 'd' + Math.random().toString(36).slice(2, 8);
    await loadRuntime(c);
    state.designs.splice(state.designs.indexOf(d) + 1, 0, c);
    state.selected = c.id;
    renderPanes(); markStale(); save();
  }

  function removeDesign(d) {
    const i = state.designs.indexOf(d);
    state.designs.splice(i, 1);
    state.selected = (state.designs[i] || state.designs[i - 1] || {}).id || null;
    if (sheet) sheet.stickers = sheet.stickers.filter((s) => s.designId !== d.id);
    if (!state.designs.length) sheet = null;
    renderAll(); save();
    if (state.designs.length) markStale();
  }

  function renderSheetPane() {
    const pane = $('#pane-sheet');
    pane.textContent = '';
    const p = state.page;
    const dims = h('div');
    const buildDims = () => {
      dims.textContent = '';
      if (p.preset === 'Custom') dims.append(numRow('Width', p, 'w', { min: 40, max: 1000, slider: false, unit: 'mm', after: updateDimsNote }), numRow('Height', p, 'h', { min: 40, max: 1000, slider: false, unit: 'mm', after: updateDimsNote }));
    };
    const note = h('p', { class: 'hint' });
    const updateDimsNote = () => { const d = pageDims(); note.textContent = `${d.w} × ${d.h} mm`; };
    buildDims(); updateDimsNote();
    const orient = segRow('Orientation', p.landscape, [[false, 'Portrait'], [true, 'Landscape']], (v) => { p.landscape = v; updateDimsNote(); markStale(); save(); });
    pane.append(
      h('div', { class: 'sect' }, h('h3', {}, 'Page'),
        selectRow('Size', p, 'preset', [...Object.keys(PRESETS), 'Custom'].map((k) => [k, k]), { after: () => { buildDims(); updateDimsNote(); } }),
        dims, h('div', { class: 'row full' }, orient), note,
        h('div', { style: 'height:12px' }),
        numRow('Margin', p, 'margin', { min: 0, max: 30, step: 0.5, unit: 'mm' }),
        numRow('Gap between stickers', p, 'gap', { min: 0, max: 15, step: 0.5, unit: 'mm' }),
        h('p', { class: 'hint', style: 'margin-top:-4px' }, 'Keep the margin clear of your printer\'s unprintable edge. The gap leaves room for scissors.')),
      h('div', { class: 'sect' }, h('h3', {}, 'Cut line'),
        toggleRow('Draw cut lines', state.cut, 'show', { kind: 'style' }),
        colorRow('Colour', state.cut, 'color'),
        numRow('Thickness', state.cut, 'width', { min: 0.05, max: 1.5, step: 0.05, unit: 'mm', kind: 'style' }),
        toggleRow('Dashed', state.cut, 'dash', { kind: 'style' }),
        colorRow('Sticker base', state.base, 'color'),
        h('p', { class: 'hint', style: 'margin-top:-4px' }, 'The base is the border printed around the artwork. White is normal for paper stickers.')),
      h('div', { class: 'sect' }, h('h3', {}, 'Packing'),
        numRow('Search effort', state.pack, 'tries', { min: 2, max: 120, step: 1, unit: 'x' }),
        h('p', { class: 'hint', style: 'margin:-4px 0 12px' }, 'Random layouts to try, the tightest wins. More takes longer.'),
        seedRow(),
        selectRow('Precision', state.pack, 'grid', [[1.5, 'Fast (1.5 px/mm)'], [2, 'Balanced (2 px/mm)'], [3, 'Fine (3 px/mm)']]),
        toggleRow('Allow 90° rotation', state.pack, 'rotate'),
        toggleRow('Fill leftover space', state.pack, 'fill')));
  }

  function seedRow() {
    const num = h('input', { type: 'number', value: state.pack.seed, min: 0, max: 99999, step: 1, 'aria-label': 'Seed' });
    num.addEventListener('change', () => { state.pack.seed = clamp(parseInt(num.value, 10) || 0, 0, 99999); num.value = state.pack.seed; markStale(); save(); });
    const shuffle = h('button', { class: 'btn small', type: 'button', onclick: () => { state.pack.seed = Math.floor(Math.random() * 99999); num.value = state.pack.seed; save(); runPack(); } }, 'Shuffle');
    return h('div', { class: 'row' }, h('label', {}, 'Seed'), h('div', { class: 'ctl' }, shuffle, num));
  }

  function renderExportPane() {
    const pane = $('#pane-export');
    pane.textContent = '';
    const card = (title, desc, label, fn) => h('div', { class: 'export-card' }, h('b', {}, title), h('span', {}, desc), h('button', { class: 'btn', type: 'button', onclick: fn, disabled: !sheet }, label));
    const { w, h: hh } = sheet ? { w: sheet.pageW, h: sheet.pageH } : pageDims();
    const px = (dpi) => `${Math.round((w / 25.4) * dpi)} × ${Math.round((hh / 25.4) * dpi)} px`;
    pane.append(
      h('div', { class: 'sect' }, h('h3', {}, 'Raster'),
        selectRow('Resolution', state.out, 'dpi', [[150, '150 dpi'], [300, '300 dpi'], [600, '600 dpi']], { kind: 'style', after: renderExportPane }),
        h('p', { class: 'hint', style: 'margin:-4px 0 8px' }, px(state.out.dpi) + '. 600 is what the original script made.'),
        card('PNG', 'Flattened onto white at the exact page size.', 'Download', () => exportAs('png')),
        card('PDF', 'The same pixels wrapped in a page of the true size. Prints 1:1.', 'Download', () => exportAs('pdf'))),
      h('div', { class: 'sect' }, h('h3', {}, 'Vector'),
        card('SVG', 'Page in millimetres, artwork embedded. Opens in Inkscape or a cutter.', 'Download', () => exportAs('svg')),
        card('Print', 'Opens the print dialog with a page-sized SVG. Choose Save as PDF for vector output.', 'Print', () => exportAs('print'))),
      h('div', { class: 'sect' }, h('h3', {}, 'Project'),
        card('Save project', 'Everything, artwork included, in one JSON file.', 'Save', saveProject),
        card('Open project', 'Replaces what is on screen right now.', 'Open', openProject)));
  }

  async function exportAs(kind) {
    if (!sheet) return;
    const dm = dmap(), st = styleOf(), dpi = state.out.dpi;
    try {
      if (kind === 'svg') Render.download(new Blob([Render.buildSVG(sheet, dm, st)], { type: 'image/svg+xml' }), 'sticker-sheet.svg');
      else if (kind === 'print') {
        $('#printHost').innerHTML = `<style>@page{size:${sheet.pageW}mm ${sheet.pageH}mm;margin:0}</style>` + Render.buildSVG(sheet, dm, st).replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" height="100%"');
        setTimeout(() => window.print(), 80);
      } else {
        toast('Rendering...');
        await tick();
        const c = Render.sheetCanvas(sheet, dm, st, dpi);
        if (kind === 'png') {
          // tag the PNG with its dpi so it prints at true size
          const blob = await Render.toBlob(c, 'image/png');
          Render.download(await withPngDpi(blob, dpi), `sticker-sheet-${dpi}dpi.png`);
        } else Render.download(await Render.pdfFromCanvas(c, sheet.pageW, sheet.pageH), 'sticker-sheet.pdf');
        toast('Done.');
      }
    } catch (e) { console.error(e); toast(e.message); }
  }

  // insert a pHYs chunk after IHDR
  async function withPngDpi(blob, dpi) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4);
    dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
    let crc = ~0;
    for (let i = 4; i < 17; i++) { crc ^= chunk[i]; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    dv.setUint32(17, ~crc >>> 0);
    const at = 8 + 25; // signature + IHDR (4 len + 4 type + 13 data + 4 crc)
    const out = new Uint8Array(buf.length + chunk.length);
    out.set(buf.subarray(0, at)); out.set(chunk, at); out.set(buf.subarray(at), at + chunk.length);
    return new Blob([out], { type: 'image/png' });
  }

  function saveProject() { Render.download(new Blob([JSON.stringify(state)], { type: 'application/json' }), 'kisscut-project.json'); }

  function openProject() {
    const inp = h('input', { type: 'file', accept: '.json,application/json' });
    inp.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await readAs(inp.files[0], 'readAsText'));
        await restore(data);
        toast('Project loaded.');
      } catch (e) { toast('Could not open that project: ' + e.message); }
    });
    inp.click();
  }

  async function restore(data) {
    const base = freshState();
    const next = { ...base, ...data, page: { ...base.page, ...data.page }, cut: { ...base.cut, ...data.cut }, base: { ...base.base, ...data.base }, pack: { ...base.pack, ...data.pack }, out: { ...base.out, ...data.out } };
    next.designs = [];
    for (const raw of data.designs || []) {
      const d = newDesign(raw.name, raw.dataUrl, { ...raw, shape: { ...raw.shape }, outline: { ...raw.outline } });
      await loadRuntime(d);
      next.designs.push(d);
    }
    state = next;
    sheet = null; cutCache.clear(); itemCache.clear();
    renderAll(); save();
    if (state.designs.length) runPack();
  }

  // ---------- wiring ----------
  function init() {
    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.tab = b.dataset.tab; renderTabs(); if (state.tab === 'export') renderExportPane(); });
    $('#btnPack').addEventListener('click', runPack);
    $('#btnExport').addEventListener('click', () => { state.tab = 'export'; renderExportPane(); renderTabs(); });
    $('#emptyPick').addEventListener('click', () => $('#file').click());
    $('#emptySamples').addEventListener('click', addSamples);
    $('#file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

    const stage = $('#stage');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; stage.classList.add('drag'); } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; stage.classList.remove('drag'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; stage.classList.remove('drag'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

    const setZoom = (z) => { zoom = clamp(z, 0.4, 5); fit(); };
    $('#zIn').addEventListener('click', () => setZoom(zoom * 1.25));
    $('#zOut').addEventListener('click', () => setZoom(zoom / 1.25));
    $('#zFit').addEventListener('click', () => setZoom(1));
    $('#scroll').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
    new ResizeObserver(fit).observe($('#scroll'));
    window.addEventListener('afterprint', () => { $('#printHost').innerHTML = ''; });

    (async () => {
      try {
        const saved = await idb.get('project');
        if (saved && saved.designs && saved.designs.length) { await restore(saved); return; }
      } catch (e) { /* no saved project */ }
      renderAll();
    })();
  }

  init();
  window.Kisscut = { get state() { return state; }, get sheet() { return sheet; }, runPack, addSamples };
})();
