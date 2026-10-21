/* Person cut-out + QUICK background fill. Runs in the browser (no server needed).
 *
 * cutOutPerson(canvas, polygon)      manual outline drawn by the user
 * cutOutFromMask(canvas, mask, box)  any mask (e.g. the one the AI server returned)
 *   -> { bg, person, origin, maskCanvas }
 *   bg         : canvas = the picture WITHOUT the person (hole filled QUICKLY)
 *   person     : canvas = only the person, transparent around, soft edges
 *   origin     : {x, y} where the person was
 *   maskCanvas : full-size canvas, white = person (sent to the server for the good fill)
 *
 * The quick fill is a simple interpolation + smoothing: fine on plain walls / sky / grass,
 * blurry on busy backgrounds. It is only shown for a moment: images.js asks the server
 * (LaMa AI model) for the real fill and swaps it in when it arrives.
 */
function makeCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function cutOutPerson(srcCanvas, poly) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const n = poly.length;

  // ---- bounding box of the outline
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX)), y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(w - 1, Math.ceil(maxX)), y1 = Math.min(h - 1, Math.ceil(maxY));
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 2 || bh < 2) throw new Error('Selected area is too small.');

  // ---- 1) mask: fill the inside of the outline (scan-line polygon fill)
  const mask = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[i].y, yj = poly[j].y;
      if ((yi > yc) !== (yj > yc)) xs.push(poly[i].x + ((yc - yi) * (poly[j].x - poly[i].x)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) mask[y * w + x] = 1;
    }
  }

  return cutOutFromMask(srcCanvas, mask, { x0, y0, x1, y1 });
}

/* mask = Uint8Array(w*h), 1 = person.  box = bounding box of the mask (inclusive pixels). */
function cutOutFromMask(srcCanvas, mask, box) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const { x0, y0, x1, y1 } = box;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  // ---- 2) the person: copy the pixels inside the mask, soften the edge (feather)
  const personData = new ImageData(bw, bh);
  const pd = personData.data;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const gx = x0 + x, gy = y0 + y;
      if (!mask[gy * w + gx]) continue;
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = gx + dx, yy = gy + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || mask[yy * w + xx]) sum++;
        }
      }
      const si = (gy * w + gx) * 4, di = (y * bw + x) * 4;
      pd[di] = src[si]; pd[di + 1] = src[si + 1]; pd[di + 2] = src[si + 2];
      pd[di + 3] = Math.round((sum * 255) / 25);
    }
  }
  const person = makeCanvas(bw, bh);
  person.getContext('2d').putImageData(personData, 0, 0);

  // ---- 3) the hole = the mask grown by 5 pixels (removes the old outline / halo)
  const R = 5;
  const rx0 = Math.max(0, x0 - R - 1), ry0 = Math.max(0, y0 - R - 1);
  const rx1 = Math.min(w - 1, x1 + R + 1), ry1 = Math.min(h - 1, y1 + R + 1);
  const tmp = new Uint8Array(w * h);
  const hole = new Uint8Array(w * h);
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      for (let k = -R; k <= R; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && mask[y * w + xx]) { tmp[y * w + x] = 1; break; }
      }
    }
  }
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      for (let k = -R; k <= R; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) { hole[y * w + x] = 1; break; }
      }
    }
  }

  // ---- 4) fill the hole: interpolate from the pixels around it, then smooth
  const col = new Float32Array(w * h * 3);
  const cnt = new Uint8Array(w * h);

  // horizontal pass: blend between the known pixel on the left and on the right
  for (let y = ry0; y <= ry1; y++) {
    let x = rx0;
    while (x <= rx1) {
      if (!hole[y * w + x]) { x++; continue; }
      const a = x;
      while (x <= rx1 && hole[y * w + x]) x++;
      const b = x - 1;
      const l = a - 1, r = b + 1;
      const hasL = l >= 0 && !hole[y * w + l];
      const hasR = r < w && !hole[y * w + r];
      if (!hasL && !hasR) continue;
      for (let xx = a; xx <= b; xx++) {
        const t = (xx - a + 1) / (b - a + 2);
        const idx = y * w + xx;
        for (let c = 0; c < 3; c++) {
          let v;
          if (hasL && hasR) v = src[(y * w + l) * 4 + c] * (1 - t) + src[(y * w + r) * 4 + c] * t;
          else if (hasL) v = src[(y * w + l) * 4 + c];
          else v = src[(y * w + r) * 4 + c];
          col[idx * 3 + c] += v;
        }
        cnt[idx]++;
      }
    }
  }
  // vertical pass: same idea, top to bottom
  for (let x = rx0; x <= rx1; x++) {
    let y = ry0;
    while (y <= ry1) {
      if (!hole[y * w + x]) { y++; continue; }
      const a = y;
      while (y <= ry1 && hole[y * w + x]) y++;
      const b = y - 1;
      const u = a - 1, d = b + 1;
      const hasU = u >= 0 && !hole[u * w + x];
      const hasD = d < h && !hole[d * w + x];
      if (!hasU && !hasD) continue;
      for (let yy = a; yy <= b; yy++) {
        const t = (yy - a + 1) / (b - a + 2);
        const idx = yy * w + x;
        for (let c = 0; c < 3; c++) {
          let v;
          if (hasU && hasD) v = src[(u * w + x) * 4 + c] * (1 - t) + src[(d * w + x) * 4 + c] * t;
          else if (hasU) v = src[(u * w + x) * 4 + c];
          else v = src[(d * w + x) * 4 + c];
          col[idx * 3 + c] += v;
        }
        cnt[idx]++;
      }
    }
  }
  // average the two passes (fallback colour: average of the photo)
  let mr = 0, mg = 0, mb = 0, ms = 0;
  for (let i = 0; i < w * h; i += 37) { mr += src[i * 4]; mg += src[i * 4 + 1]; mb += src[i * 4 + 2]; ms++; }
  const fallback = [mr / ms, mg / ms, mb / ms];
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const idx = y * w + x;
      if (!hole[idx]) continue;
      for (let c = 0; c < 3; c++) col[idx * 3 + c] = cnt[idx] ? col[idx * 3 + c] / cnt[idx] : fallback[c];
    }
  }
  // smoothing: every hole pixel becomes the average of its 4 neighbours (repeated)
  const val = (idx, c) => (hole[idx] ? col[idx * 3 + c] : src[idx * 4 + c]);
  for (let iter = 0; iter < 40; iter++) {
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const idx = y * w + x;
        if (!hole[idx]) continue;
        for (let c = 0; c < 3; c++) {
          let s = 0, k = 0;
          if (x > 0) { s += val(idx - 1, c); k++; }
          if (x < w - 1) { s += val(idx + 1, c); k++; }
          if (y > 0) { s += val(idx - w, c); k++; }
          if (y < h - 1) { s += val(idx + w, c); k++; }
          col[idx * 3 + c] = s / k;
        }
      }
    }
  }

  const bgData = new ImageData(new Uint8ClampedArray(src), w, h);
  const bd = bgData.data;
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const idx = y * w + x;
      if (!hole[idx]) continue;
      for (let c = 0; c < 3; c++) bd[idx * 4 + c] = col[idx * 3 + c];
      bd[idx * 4 + 3] = 255;
    }
  }
  const bg = makeCanvas(w, h);
  bg.getContext('2d').putImageData(bgData, 0, 0);

  // full-size mask picture (white = person), for the server
  const md = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] ? 255 : 0;
    md.data[i * 4] = v; md.data[i * 4 + 1] = v; md.data[i * 4 + 2] = v; md.data[i * 4 + 3] = 255;
  }
  const maskCanvas = makeCanvas(w, h);
  maskCanvas.getContext('2d').putImageData(md, 0, 0);

  return { bg, person, origin: { x: x0, y: y0 }, maskCanvas };
}

/* Mask canvas (white = person) -> { mask: Uint8Array, box } */
function maskFromCanvas(maskCanvas) {
  const w = maskCanvas.width, h = maskCanvas.height;
  const d = maskCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] > 127) {
        mask[y * w + x] = 1;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('Empty selection.');
  return { mask, box: { x0, y0, x1, y1 } };
}

/* data:image/png;base64,... -> canvas */
function dataUrlToCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Could not read the picture from the server.'));
    img.src = url;
  });
}

/* Paste the person on the background at pos with the given size factor. Returns a new canvas.
 * opts.shadow = true adds a soft contact shadow (see harmonize.js). */
function composePerson(bg, person, pos, scale, opts) {
  const out = makeCanvas(bg.width, bg.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(bg, 0, 0);
  paintPerson(ctx, person, pos, scale, opts || {});
  return out;
}
