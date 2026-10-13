// Turns a packed sheet into SVG, canvas pixels, PNG and PDF.
(function (global) {
  'use strict';

  const f = (n) => (Math.round(n * 1000) / 1000).toString();
  const ringD = (ring) => 'M' + ring.map((p) => f(p[0]) + ',' + f(p[1])).join('L') + 'Z';
  const silD = (rings) => rings.map((r) => ringD(r)).join('');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // style: { cut:{show,color,width,dash}, base:{color}, paper:{color} }; designs: Map id -> design with .rt runtime
  function buildSVG(sheet, designs, style) {
    const used = [...new Set(sheet.stickers.map((s) => s.designId))];
    let defs = '';
    for (const id of used) {
      const d = designs.get(id);
      if (!d || !d.rt) continue;
      const { crop, natW, natH, dataUrl } = d.rt;
      defs += `<symbol id="d-${id}" viewBox="${f(crop.x)} ${f(crop.y)} ${f(crop.w)} ${f(crop.h)}"><image href="${dataUrl}" width="${f(natW)}" height="${f(natH)}"/></symbol>`;
      defs += `<clipPath id="s-${id}"><path d="${silD(d.rt.silhouette)}" clip-rule="evenodd"/></clipPath>`;
    }
    const cut = style.cut;
    const dash = cut.dash ? ` stroke-dasharray="${f(cut.width * 6)} ${f(cut.width * 4)}"` : '';
    let body = '';
    for (const s of sheet.stickers) {
      const d = designs.get(s.designId);
      if (!d || !d.rt) continue;
      const path = ringD(s.ring);
      const rot = s.rot ? ' rotate(90)' : '';
      let g = `<g class="sticker" data-design="${esc(s.designId)}"><path d="${path}" fill="${style.base.color}"/>`;
      g += `<g transform="translate(${f(s.x)} ${f(s.y)})${rot}"><use href="#d-${s.designId}" width="${f(s.width)}" height="${f(s.height)}"/>`;
      if (d.outline.on) {
        g += `<g transform="scale(${f(s.width)})"><path d="${silD(d.rt.silhouette)}" fill="none" stroke="${d.outline.color}" stroke-opacity="${d.outline.opacity}" stroke-width="${f((2 * d.outline.width) / s.width)}" stroke-linejoin="round" clip-path="url(#s-${s.designId})"/></g>`;
      }
      g += '</g>';
      if (cut.show) g += `<path class="cut" d="${path}" fill="none" stroke="${cut.color}" stroke-width="${f(cut.width)}" stroke-linejoin="round"${dash}/>`;
      body += g + '</g>';
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(sheet.pageW)}mm" height="${f(sheet.pageH)}mm" viewBox="0 0 ${f(sheet.pageW)} ${f(sheet.pageH)}"><defs>${defs}</defs><rect width="${f(sheet.pageW)}" height="${f(sheet.pageH)}" fill="${style.paper.color}"/>${body}</svg>`;
  }

  // Draws straight onto a canvas at k pixels per mm
  function drawSheet(ctx, sheet, designs, style, k) {
    ctx.save();
    ctx.scale(k, k);
    ctx.fillStyle = style.paper.color;
    ctx.fillRect(0, 0, sheet.pageW, sheet.pageH);
    for (const s of sheet.stickers) {
      const d = designs.get(s.designId);
      if (!d || !d.rt) continue;
      const path = new Path2D(ringD(s.ring));
      ctx.fillStyle = style.base.color;
      ctx.fill(path);
      ctx.save();
      ctx.translate(s.x, s.y);
      if (s.rot) ctx.rotate(Math.PI / 2);
      const { crop, img } = d.rt;
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, s.width, s.height);
      if (d.outline.on) {
        ctx.save();
        ctx.scale(s.width, s.width);
        ctx.clip(new Path2D(silD(d.rt.silhouette)), 'evenodd');
        ctx.globalAlpha = d.outline.opacity;
        ctx.strokeStyle = d.outline.color;
        ctx.lineWidth = (2 * d.outline.width) / s.width;
        ctx.lineJoin = 'round';
        ctx.stroke(new Path2D(silD(d.rt.silhouette)));
        ctx.restore();
      }
      ctx.restore();
      if (style.cut.show) {
        ctx.strokeStyle = style.cut.color;
        ctx.lineWidth = style.cut.width;
        ctx.lineJoin = 'round';
        ctx.setLineDash(style.cut.dash ? [style.cut.width * 6, style.cut.width * 4] : []);
        ctx.stroke(path);
      }
    }
    ctx.restore();
  }

  function sheetCanvas(sheet, designs, style, dpi) {
    const k = dpi / 25.4;
    const c = document.createElement('canvas');
    c.width = Math.round(sheet.pageW * k);
    c.height = Math.round(sheet.pageH * k);
    drawSheet(c.getContext('2d'), sheet, designs, style, k);
    return c;
  }

  const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas export failed, the page may be too large for this browser.'))), type, q));

  // Single-page PDF holding one JPEG, scaled to the exact page size
  async function pdfFromCanvas(canvas, pageWmm, pageHmm) {
    const jpg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.93)).arrayBuffer());
    const pw = (pageWmm / 25.4) * 72, ph = (pageHmm / 25.4) * 72;
    const enc = new TextEncoder();
    const chunks = [];
    let len = 0;
    const offsets = [];
    const add = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
    add('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const obj = (n, body) => { offsets[n] = len; add(`${n} 0 obj\n`); add(body); add('\nendobj\n'); };
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4] = len;
    add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    add(jpg);
    add('\nendstream\nendobj\n');
    const content = `q ${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} 0 0 cm /Im0 Do Q`;
    obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const xref = len;
    add('xref\n0 6\n0000000000 65535 f \n');
    for (let i = 1; i <= 5; i++) add(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
    add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  global.Render = { buildSVG, drawSheet, sheetCanvas, pdfFromCanvas, toBlob, download, ringD };
})(window);
