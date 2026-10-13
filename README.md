# Kisscut

A sticker sheet maker that runs in the browser. No build step, no dependencies.

Open `index.html` directly, or serve the folder (`python3 -m http.server`) and visit it.

1. Drop in SVG, PNG, WebP or JPG artwork.
2. Per design: which widths you want, a filler size for leftover space, and a cut shape (outline, hull, rect, circle, hex) with border, rounding and edge blur.
3. Pick a page size, margin and gap, then Pack sheet.
4. Export PNG or PDF (150/300/600 dpi), SVG, or print to a vector PDF.

Your work is autosaved in the browser (IndexedDB). Save project writes it all to a JSON file.
