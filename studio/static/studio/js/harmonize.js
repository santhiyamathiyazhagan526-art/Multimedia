/* Make a moved person FIT the new place. Runs in the browser.
 *
 * Idea: the person's colours were lit by the light at the OLD place. We measure the
 * average colour / brightness of the surroundings at the old place and at the new place,
 * and move the person's colours by the DIFFERENCE (in the Lab colour space, where
 * "brightness" and "colour" are separate). If both places look the same, nothing changes.
 * Brightness follows the new place fully; colour only half, so a pink saree stays pink.
 *
 *   ringStats(canvas, rect)                  average Lab colour of the area AROUND rect
 *   harmonizePerson(person, from, to, k)     person canvas recoloured (k = 0..1 strength)
 *   paintPerson(ctx, person, pos, s, opts)   draws the person (+ optional shadow / glow)
 */

/* ---------- sRGB <-> Lab (D65). Plain functions on numbers, so they are easy to test. */
const _LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  _LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function _fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
function _fInv(t) { return t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787; }
function _gamma(c) {
  c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/* r, g, b: 0..255  ->  [L (0..100), a, b] */
function rgbToLab(r, g, b) {
  const R = _LIN[r], G = _LIN[g], B = _LIN[b];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = _fLab(x), fy = _fLab(y), fz = _fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/* L, a, b -> [r, g, b] (0..255 integers) */
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = _fInv(fx) * 0.95047, y = _fInv(fy), z = _fInv(fz) * 1.08883;
  return [
    _gamma(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    _gamma(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    _gamma(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

/* ---------- average colour of the ring around a rectangle */

/* data = RGBA pixels of the region that starts at (ox, oy) in the picture and is w x h.
 * Pixels inside rect (the person's own box) are skipped. Returns {L, a, b, n} or null. */
function ringMeanLab(data, w, h, ox, oy, rect) {
  let sL = 0, sa = 0, sb = 0, n = 0;
  for (let y = 0; y < h; y += 2) {
    const gy = oy + y;
    for (let x = 0; x < w; x += 2) {
      const gx = ox + x;
      if (gx >= rect.x && gx < rect.x + rect.w && gy >= rect.y && gy < rect.y + rect.h) continue;
      const i = (y * w + x) * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      sL += lab[0]; sa += lab[1]; sb += lab[2]; n++;
    }
  }
  return n < 40 ? null : { L: sL / n, a: sa / n, b: sb / n, n };
}

function ringStats(canvas, rect) {
  const m = Math.max(24, Math.round(0.3 * Math.max(rect.w, rect.h)));
  const x0 = Math.max(0, Math.floor(rect.x - m)), y0 = Math.max(0, Math.floor(rect.y - m));
  const x1 = Math.min(canvas.width, Math.ceil(rect.x + rect.w + m));
  const y1 = Math.min(canvas.height, Math.ceil(rect.y + rect.h + m));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const img = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
  return ringMeanLab(img.data, img.width, img.height, x0, y0, rect);
}

/* ---------- recolour the person */
const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* Moves every visible pixel by (dL, da, db) in Lab. Changes `data` in place. */
function shiftLab(data, dL, da, db) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const rgb = labToRgb(_clamp(lab[0] + dL, 0, 100), lab[1] + da, lab[2] + db);
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
  }
}

/* The amounts to shift, from the surroundings at the old place (from) and the new one (to). */
function lightDifference(from, to, strength) {
  return {
    dL: _clamp((to.L - from.L) * strength, -25, 25),
    da: _clamp((to.a - from.a) * strength * 0.5, -10, 10),
    db: _clamp((to.b - from.b) * strength * 0.5, -10, 10),
  };
}

function harmonizePerson(person, from, to, strength) {
  if (!from || !to || strength <= 0) return person;
  const d = lightDifference(from, to, strength);
  if (Math.abs(d.dL) + Math.abs(d.da) + Math.abs(d.db) < 0.6) return person; // looks the same already
  const out = makeCanvas(person.width, person.height);
  const octx = out.getContext('2d');
  const img = person.getContext('2d').getImageData(0, 0, person.width, person.height);
  shiftLab(img.data, d.dL, d.da, d.db);
  octx.putImageData(img, 0, 0);
  return out;
}

/* ---------- drawing */

/* A flat, blurred copy of the person on the ground = contact shadow. */
function drawShadow(ctx, person, pos, scale) {
  const w = person.width * scale, h = person.height * scale;
  const sil = makeCanvas(person.width, person.height);
  const sctx = sil.getContext('2d');
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, sil.width, sil.height);
  sctx.globalCompositeOperation = 'destination-in';
  sctx.drawImage(person, 0, 0);

  const flat = Math.max(6, h * 0.1);
  ctx.save();
  if ('filter' in ctx) ctx.filter = `blur(${Math.max(2, w * 0.04).toFixed(1)}px)`;
  ctx.globalAlpha = 0.35;
  ctx.drawImage(sil, pos.x + w * 0.08, pos.y + h - flat * 0.6, w, flat);
  ctx.restore();
}

/* opts: { shadow: bool, glow: number }  glow = yellow outline thickness (preview only) */
function paintPerson(ctx, person, pos, scale, opts) {
  const w = person.width * scale, h = person.height * scale;
  ctx.imageSmoothingQuality = 'high';
  if (opts.shadow) drawShadow(ctx, person, pos, scale);
  if (opts.glow) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 235, 59, 0.95)';
    ctx.shadowBlur = opts.glow;
    ctx.drawImage(person, pos.x, pos.y, w, h);
    ctx.restore();
  }
  ctx.drawImage(person, pos.x, pos.y, w, h);
}
