// Small geometry toolkit: distance fields, contour tracing, polygon helpers.
(function (global) {
  'use strict';
  const INF = 1e20;

  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
  }

  // distance from every pixel to the nearest pixel where feat is set
  function edt(feat, w, h) {
    const g = new Float64Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = feat[i] ? 0 : INF;
    const m = Math.max(w, h);
    const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  // signed distance in pixels, negative inside
  function sdf(mask, w, h) {
    const inv = new Uint8Array(mask.length);
    for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
    const dOut = edt(mask, w, h), dIn = edt(inv, w, h);
    const out = new Float32Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0.5 - dIn[i] : dOut[i] - 0.5;
    return out;
  }

  const SEG = {
    1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]],
    8: [[3, 2]], 9: [[0, 2]], 10: [[0, 1], [3, 2]], 11: [[1, 2]], 12: [[3, 1]], 13: [[0, 1]], 14: [[3, 0]],
  };

  // marching squares: closed loops around the region where f < level, in grid coordinates
  function trace(f, w, h, level) {
    const segs = [];
    const adj = new Map();
    const push = (id, si) => { const a = adj.get(id); if (a) a.push(si); else adj.set(id, [si]); };
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        const code = (f[i] < level ? 1 : 0) | (f[i + 1] < level ? 2 : 0) | (f[i + w + 1] < level ? 4 : 0) | (f[i + w] < level ? 8 : 0);
        if (code === 0 || code === 15) continue;
        // edge ids: top, right, bottom, left
        const e = [i * 2, (i + 1) * 2 + 1, (i + w) * 2, i * 2 + 1];
        for (const [a, b] of SEG[code]) {
          const si = segs.length;
          segs.push([e[a], e[b]]);
          push(e[a], si); push(e[b], si);
        }
      }
    }
    const cache = new Map();
    const pt = (id) => {
      let p = cache.get(id);
      if (p) return p;
      const i = id >> 1, x = i % w, y = (i / w) | 0;
      if (id & 1) { const a = f[i], b = f[i + w]; p = [x, y + (level - a) / (b - a)]; }
      else { const a = f[i], b = f[i + 1]; p = [x + (level - a) / (b - a), y]; }
      cache.set(id, p);
      return p;
    };
    const seen = new Uint8Array(segs.length);
    const loops = [];
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (seen[s0]) continue;
      const loop = [];
      let seg = s0, from = segs[s0][0];
      while (seg !== -1 && !seen[seg]) {
        seen[seg] = 1;
        const [a, b] = segs[seg];
        const next = a === from ? b : a;
        loop.push(pt(from));
        from = next;
        seg = -1;
        for (const c of adj.get(next)) if (!seen[c]) { seg = c; break; }
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function area(r) {
    let a = 0;
    for (let i = 0, n = r.length; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function length(r) {
    let l = 0;
    for (let i = 0, n = r.length; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n];
      l += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
    return l;
  }

  function dpOpen(pts, eps, out) {
    const stack = [[0, pts.length - 1]];
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      const [s, e] = stack.pop();
      const [x1, y1] = pts[s], [x2, y2] = pts[e];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-9;
      let md = 0, mi = -1;
      for (let i = s + 1; i < e; i++) {
        const d = Math.abs((pts[i][0] - x1) * dy - (pts[i][1] - y1) * dx) / len;
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
    }
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  }

  // Douglas-Peucker on a closed ring
  function simplify(ring, eps) {
    if (ring.length < 8 || eps <= 0) return ring;
    let far = 0, fd = 0;
    for (let i = 1; i < ring.length; i++) {
      const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
      if (d > fd) { fd = d; far = i; }
    }
    const a = [], b = [];
    dpOpen(ring.slice(0, far + 1), eps, a);
    dpOpen(ring.slice(far).concat([ring[0]]), eps, b);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    const up = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // even spacing along the ring, then a gaussian blur of the coordinates around the loop
  function blurRing(ring, step, sigma) {
    const n = Math.max(64, Math.round(length(ring) / step));
    const total = length(ring);
    const pts = [];
    let seg = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      const target = (i * total) / n;
      for (;;) {
        const p = ring[seg % ring.length], q = ring[(seg + 1) % ring.length];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (acc + l >= target || seg > ring.length * 2) {
          const t = l ? (target - acc) / l : 0;
          pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
          break;
        }
        acc += l; seg++;
      }
    }
    const half = Math.max(1, Math.round((3 * sigma) / (total / n)));
    const k = [];
    let ks = 0;
    for (let i = -half; i <= half; i++) { const v = Math.exp(-0.5 * ((i * (total / n)) / sigma) ** 2); k.push(v); ks += v; }
    return pts.map((_, i) => {
      let x = 0, y = 0;
      for (let j = -half; j <= half; j++) {
        const p = pts[((i + j) % n + n) % n], w = k[j + half] / ks;
        x += p[0] * w; y += p[1] * w;
      }
      return [x, y];
    });
  }

  function cnv(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // fill rings (even-odd) into a binary mask
  function raster(rings, w, h) {
    const c = cnv(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.beginPath();
    for (const r of rings) {
      r.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
    }
    ctx.fillStyle = '#000';
    ctx.fill('evenodd');
    const d = ctx.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return out;
  }

  // flood the outside from the corner; anything left unreached is inside the shape
  function fillHoles(m, w, h) {
    const out = m.slice();
    const stack = [0];
    const seen = new Uint8Array(m.length);
    seen[0] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !seen[j] && !m[j]) { seen[j] = 1; stack.push(j); }
    }
    for (let i = 0; i < out.length; i++) if (!seen[i]) out[i] = 1;
    return out;
  }

  global.Geo = { edt, sdf, trace, area, length, simplify, hull, blurRing, raster, fillHoles, cnv };
})(window);
