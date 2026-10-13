// Sticker packing: bitmask occupancy grid, top-left first fit, many random orderings, best one wins.
(function (global) {
  'use strict';
  const { cnv } = global.Geo;
  let uid = 0;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bounds(ring) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }

  function ringArea(r) {
    let a = 0;
    for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a / 2);
  }

  const rowOrder = (n) => {
    const seen = new Uint8Array(n), out = [];
    for (const s of [16, 8, 4, 2, 1]) for (let i = 0; i < n; i += s) if (!seen[i]) { seen[i] = 1; out.push(i); }
    return Int32Array.from(out);
  };

  // One orientation of an item: footprint bitmap (cut line grown by half the gap) on the packing grid
  function makeRot(ring, rot, grid, gap) {
    const [x0, y0, x1, y1] = bounds(ring);
    const fx0 = x0 - gap / 2, fy0 = y0 - gap / 2;
    const fw = Math.ceil((x1 - x0 + gap) * grid) + 1, fh = Math.ceil((y1 - y0 + gap) * grid) + 1;
    const c = cnv(fw, fh), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(grid, 0, 0, grid, -fx0 * grid, -fy0 * grid);
    ctx.beginPath();
    ring.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill();
    if (gap > 0) { ctx.lineWidth = gap; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.stroke(); }
    const d = ctx.getImageData(0, 0, fw, fh).data;
    const k = new Uint8Array(fw * fh);
    for (let i = 0; i < k.length; i++) k[i] = d[i * 4 + 3] > 0 ? 1 : 0;
    return { ring, rot, fx0, fy0, fw, fh, k, shifts: new Array(32), order: rowOrder(fh) };
  }

  function shifted(r, s) {
    if (r.shifts[s]) return r.shifts[s];
    const nw = Math.ceil((r.fw + s) / 32);
    const bits = new Uint32Array(r.fh * nw);
    for (let y = 0; y < r.fh; y++) {
      for (let x = 0; x < r.fw; x++) {
        if (!r.k[y * r.fw + x]) continue;
        const pos = x + s;
        bits[y * nw + (pos >> 5)] |= 1 << (pos & 31);
      }
    }
    return (r.shifts[s] = { bits, nw });
  }

  // item: one sticker at one size. ring is in the artwork frame (mm), top-left of the artwork = 0,0
  function makeItem(designId, width, aspect, ring, cfg) {
    const rots = [makeRot(ring, 0, cfg.grid, cfg.gap)];
    if (cfg.rotate) {
      const rr = ring.map(([x, y]) => [-y, x]);
      rots.push(makeRot(rr, 90, cfg.grid, cfg.gap));
    }
    return { uid: ++uid, designId, width, height: aspect * width, ring, rots, area: ringArea(ring) };
  }

  class Grid {
    constructor(cfg) {
      this.cfg = cfg;
      this.w = Math.floor((cfg.pageW - 2 * cfg.margin + cfg.gap) * cfg.grid);
      this.h = Math.floor((cfg.pageH - 2 * cfg.margin + cfg.gap) * cfg.grid);
      this.words = Math.ceil(this.w / 32);
      this.occ = new Uint32Array(this.h * this.words);
      this.failed = new Set();
    }

    // first free spot, top-most then left-most, over every allowed orientation
    place(item) {
      let best = null;
      for (const rot of item.rots) {
        const key = item.uid * 4 + rot.rot / 90;
        if (this.failed.has(key)) continue;
        const spot = this.scan(rot);
        if (!spot) { this.failed.add(key); continue; }
        if (!best || spot[0] < best.r || (spot[0] === best.r && spot[1] < best.c)) best = { r: spot[0], c: spot[1], rot };
      }
      if (!best) return null;
      this.mark(best.rot, best.r, best.c);
      const { cfg } = this;
      return {
        item, rot: best.rot,
        x: best.c / cfg.grid - best.rot.fx0 + cfg.margin - cfg.gap / 2,
        y: best.r / cfg.grid - best.rot.fy0 + cfg.margin - cfg.gap / 2,
      };
    }

    scan(rot) {
      const { w, h, words, occ } = this;
      if (rot.fw > w || rot.fh > h) return null;
      const order = rot.order, fh = rot.fh;
      for (let r = 0; r + fh <= h; r++) {
        for (let c = 0; c + rot.fw <= w; c++) {
          const { bits, nw } = shifted(rot, c & 31);
          const w0 = c >> 5;
          let ok = true;
          for (let oi = 0; oi < order.length && ok; oi++) {
            const i = order[oi], o = (r + i) * words + w0, b = i * nw;
            for (let j = 0; j < nw; j++) if (occ[o + j] & bits[b + j]) { ok = false; break; }
          }
          if (ok) return [r, c];
        }
      }
      return null;
    }

    mark(rot, r, c) {
      const { bits, nw } = shifted(rot, c & 31);
      const w0 = c >> 5;
      for (let i = 0; i < rot.fh; i++) for (let j = 0; j < nw; j++) this.occ[(r + i) * this.words + w0 + j] |= bits[i * nw + j];
    }
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  // plan: { required: [item], tiers: [{designId: item}], bias: {designId: n}, designIds: [] }
  async function pack(plan, cfg, hooks = {}) {
    const rng = mulberry32(cfg.seed);
    let best = null, bestScore = -Infinity;
    const t0 = performance.now();
    for (let t = 0; t < cfg.tries; t++) {
      if (hooks.cancelled && hooks.cancelled()) break;
      const grid = new Grid(cfg);
      const placed = [], missing = [];
      const order = plan.required.map((it) => ({ it, k: -it.area * (0.6 + rng() * 0.8) })).sort((a, b) => a.k - b.k).map((o) => o.it);
      for (const it of order) {
        const p = grid.place(it);
        if (p) placed.push(p); else missing.push(it);
      }
      const counts = {};
      plan.designIds.forEach((id) => (counts[id] = 0));
      placed.forEach((p) => counts[p.item.designId]++);
      if (cfg.fill) {
        for (const tier of plan.tiers) {
          const left = new Set(Object.keys(tier));
          while (left.size) {
            const name = [...left].sort().reduce((a, b) => {
              const sa = counts[a] - (plan.bias[a] || 0), sb = counts[b] - (plan.bias[b] || 0);
              return sb < sa || (sb === sa && rng() < 0.5) ? b : a;
            });
            const p = grid.place(tier[name]);
            if (!p) { left.delete(name); continue; }
            placed.push(p); counts[name]++;
          }
        }
      }
      const ev = plan.designIds.map((id) => counts[id] - (plan.bias[id] || 0));
      const spread = ev.length ? Math.max(...ev) - Math.min(...ev) : 0;
      const score = placed.reduce((s, p) => s + p.item.area, 0) - 400 * spread - 1e6 * missing.length;
      if (score > bestScore) { best = { placed, missing }; bestScore = score; }
      if (hooks.progress) hooks.progress(t + 1, cfg.tries);
      await tick();
    }
    if (best) best.ms = performance.now() - t0;
    return best;
  }

  // Positions in world mm, centred on the page
  function toSheet(result, cfg) {
    const stickers = result.placed.map((p) => ({
      designId: p.item.designId, width: p.item.width, height: p.item.height, rot: p.rot.rot,
      x: p.x, y: p.y, ring: p.rot.ring.map(([a, b]) => [a + p.x, b + p.y]),
    }));
    if (stickers.length) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const s of stickers) { const b = bounds(s.ring); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
      const dx = (cfg.pageW - (x1 - x0)) / 2 - x0, dy = (cfg.pageH - (y1 - y0)) / 2 - y0;
      for (const s of stickers) { s.x += dx; s.y += dy; s.ring = s.ring.map(([a, b]) => [a + dx, b + dy]); }
    }
    return { pageW: cfg.pageW, pageH: cfg.pageH, stickers, missing: result.missing.map((m) => ({ designId: m.designId, width: m.width })) };
  }

  global.Pack = { makeItem, pack, toSheet, mulberry32 };
})(window);
