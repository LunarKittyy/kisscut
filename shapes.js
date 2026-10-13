// Artwork analysis and cut-line generation.
(function (global) {
  'use strict';
  const { sdf, trace, area, simplify, hull, blurRing, raster, fillHoles, cnv } = global.Geo;
  const S = 5;            // px per mm while building a cut line
  const MIN_BORDER = 1.5; // smoothing never brings the cut line closer than this to the art

  // Finds the real artwork bounds and silhouette. Rings are normalised so the artwork is 0..1 wide.
  function analyze(img, natW, natH, whiteIsBg) {
    const sc = Math.min(1, 900 / Math.max(natW, natH));
    const cw = Math.max(2, Math.round(natW * sc)), ch = Math.max(2, Math.round(natH * sc));
    const c = cnv(cw, ch), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    const P = 2, gw = cw + 2 * P, gh = ch + 2 * P;
    const mask = new Uint8Array(gw * gh);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        let on = d[i + 3] > 8;
        if (on && whiteIsBg && d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) on = false;
        if (!on) continue;
        mask[(y + P) * gw + x + P] = 1;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) throw new Error('This image has nothing visible in it.');
    const bx0 = x0, by0 = y0, bw = x1 + 1 - x0, bh = y1 + 1 - y0;
    const minArea = cw * ch * 2e-5;
    const rings = trace(sdf(mask, gw, gh), gw, gh, 0)
      .filter((r) => Math.abs(area(r)) > minArea)
      .map((r) => simplify(r, 0.5).map(([x, y]) => [(x + 0.5 - P - bx0) / bw, (y + 0.5 - P - by0) / bw]));
    return {
      crop: { x: bx0 * (natW / cw), y: by0 * (natH / ch), w: bw * (natW / cw), h: bh * (natH / ch) },
      aspect: bh / bw,
      silhouette: rings,
    };
  }

  function roundedArc(cx, cy, r, a0, a1, n) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  }

  function hexagon(pts, radius, border) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const normals = [30, 90, 150, 210, 270, 330].map((a) => (a * Math.PI) / 180);
    let apothem = 0;
    for (const a of normals) for (const [x, y] of pts) apothem = Math.max(apothem, (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a));
    radius = Math.min(radius, apothem * 0.9);
    const R = (apothem - radius) / Math.cos(Math.PI / 6);
    const rr = radius + border;
    const out = [];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      out.push(...roundedArc(cx + R * Math.cos(a), cy + R * Math.sin(a), rr, a - Math.PI / 6, a + Math.PI / 6, 10));
    }
    return out;
  }

  function circle(pts, border) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let r = 0;
    for (const [x, y] of pts) r = Math.max(r, Math.hypot(x - cx, y - cy));
    return roundedArc(cx, cy, r + border, 0, Math.PI * 2, 128).slice(0, -1);
  }

  function roundRect(pts, rc, border) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    x0 -= border; y0 -= border; x1 += border; y1 += border;
    const r = Math.max(0.01, Math.min(rc + border, (x1 - x0) / 2, (y1 - y0) / 2));
    return [
      ...roundedArc(x1 - r, y1 - r, r, 0, Math.PI / 2, 12),
      ...roundedArc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, 12),
      ...roundedArc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, 12),
      ...roundedArc(x1 - r, y0 + r, r, Math.PI * 1.5, Math.PI * 2, 12),
    ];
  }

  function biggest(loops) {
    return loops.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
  }

  // The cut line for one artwork at a given width. Result is a ring in mm, artwork top-left = (0, 0).
  // p = { mode, border (mm), rounding (% of width), smooth (% of width) }
  function buildCut(design, W, p) {
    const art = design.silhouette.map((r) => r.map(([x, y]) => [x * W, y * W]));
    const all = art.flat();
    const border = p.border, round = (p.rounding / 100) * W;
    if (p.mode === 'hex') return simplify(hexagon(all, round, border), 0.02);
    if (p.mode === 'circle') return circle(all, border);
    if (p.mode === 'rrect') return roundRect(all, round, border);

    const H = design.aspect * W;
    const r = Math.max(2, round);
    const pad = Math.ceil((border + r + 3) * S) + 4;
    const gw = Math.ceil(W * S) + 2 * pad, gh = Math.ceil(H * S) + 2 * pad;
    const toPx = (ring) => ring.map(([x, y]) => [pad + x * S, pad + y * S]);
    const toMm = (ring) => ring.map(([x, y]) => [(x + 0.5 - pad) / S, (y + 0.5 - pad) / S]);

    const src = p.mode === 'hull' ? [hull(all)] : art;
    const M = raster(src.map(toPx), gw, gh);
    const sd0 = sdf(M, gw, gh);
    const D = (border + r) * S;
    const G = new Uint8Array(M.length);
    for (let i = 0; i < G.length; i++) G[i] = sd0[i] <= D ? 1 : 0;
    const sdG = sdf(fillHoles(G, gw, gh), gw, gh);
    let loops = trace(sdG, gw, gh, -r * S);
    if (!loops.length) loops = trace(sdG, gw, gh, 0);
    let ring = loops.length > 1 ? hull(loops.flat()) : loops[0];
    ring = toMm(ring);

    if (p.smooth > 0) {
      const sigma = (p.smooth / 100) * W;
      ring = blurRing(ring, 0.25, Math.max(0.3, sigma));
      for (let it = 0; it < 6; it++) {
        const R = raster([toPx(ring)], gw, gh);
        const sdR = sdf(R, gw, gh);
        let worst = 0;
        for (let i = 0; i < R.length; i++) if (sd0[i] <= MIN_BORDER * S && sdR[i] > 0 && sdR[i] > worst) worst = sdR[i];
        if (worst <= 0) break;
        ring = toMm(biggest(trace(sdR, gw, gh, worst + 0.5)));
      }
    }
    return simplify(ring, 0.03);
  }

  global.Shape = { analyze, buildCut };
})(window);
