/* Images tab: pick images, CLICK a person, drag them, undo / redo / reset, save.
 *
 * Click a person  -> server (YOLO + SAM) returns the exact body shape
 *                 -> the person is draggable at once (only the person's own pixels grab)
 *                 -> server (LaMa) fills the empty place; swapped in when ready
 * While moving    -> harmonize.js matches the person's colours / light to the new place
 * "Draw outline instead" = the old manual tool (works without the AI packages).
 */
(() => {
  const MAX_SIDE = 1280; // big photos are shrunk so editing stays fast

  const canvas = $('#imgCanvas');
  const ctx = canvas.getContext('2d');
  const scaleInput = $('#personScale');
  const blendInput = $('#personBlend');
  const shadowBox = $('#personShadow');

  let files = [];          // the files the user picked
  let history = [];        // every applied edit is a new picture (canvas) here
  let index = -1;          // which history entry is shown (undo / redo move this number)
  let mode = 'view';       // 'view' (click a person) | 'select' (manual outline) | 'move'
  let lasso = [];          // outline drawn around the person (image pixels)
  let drawing = false;
  let cut = null;          // the person being moved (see enterMove)
  let pos = { x: 0, y: 0 };
  let scale = 1;
  let drag = null;
  let tap = null;          // a press in 'view' mode: if it is a click (not a drag) we select the person
  let picking = false;     // true while the server is finding the person
  let cutSeq = 0;          // numbers every selection, so a late server answer for an old one is ignored
  let warnedBasic = false;

  const current = () => history[index];

  /* ------------------------------------------------------------ loading */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = makeCanvas(Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open this image.')); };
      img.src = url;
    });
  }

  async function showFile(i) {
    await withBusy('Loading image...', async () => {
      const c = await loadImage(files[i]);
      history = [c];
      index = 0;
      mode = 'view';
      lasso = [];
      cut = null;
      document.querySelectorAll('#imgThumbs img').forEach((t, n) => t.classList.toggle('active', n === i));
      render();
    });
  }

  $('#imgInput').addEventListener('change', async (e) => {
    files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    const thumbs = $('#imgThumbs');
    thumbs.innerHTML = '';
    if (files.length > 1) {
      files.forEach((f, i) => {
        const t = document.createElement('img');
        t.src = URL.createObjectURL(f);
        t.title = f.name;
        t.addEventListener('click', () => showFile(i));
        thumbs.appendChild(t);
      });
    }
    await showFile(0);
  });

  /* ------------------------------------------------------------ drawing */
  function render() {
    const base = mode === 'move' && cut ? cut.bg : history[index];
    $('#imgEmpty').classList.toggle('hidden', !!base);
    canvas.classList.toggle('hidden', !base);
    if (base) {
      if (canvas.width !== base.width || canvas.height !== base.height) {
        canvas.width = base.width;
        canvas.height = base.height;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      const shown = canvas.getBoundingClientRect().width || canvas.width;
      const k = canvas.width / shown; // image pixels per screen pixel (keeps lines the same thickness)

      if (mode === 'select' && lasso.length > 1) {
        ctx.beginPath();
        ctx.moveTo(lasso[0].x, lasso[0].y);
        lasso.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = 'rgba(63,81,181,0.25)';
        ctx.fill();
        ctx.lineWidth = 2 * k;
        ctx.strokeStyle = '#ffeb3b';
        ctx.stroke();
      }
      if (mode === 'move' && cut) {
        // the person with a yellow outline that follows the body shape (preview only)
        paintPerson(ctx, cut.look, pos, scale, { shadow: shadowBox.checked, glow: 7 * k });
      }
    }
    updateButtons();
  }

  function updateButtons() {
    const has = index >= 0;
    const view = mode === 'view';
    $('#imgViewTools').classList.toggle('hidden', mode !== 'view');
    $('#imgSelectTools').classList.toggle('hidden', mode !== 'select');
    $('#imgMoveTools').classList.toggle('hidden', mode !== 'move');
    $('#imgUndo').disabled = !(view && index > 0);
    $('#imgRedo').disabled = !(view && index < history.length - 1);
    $('#imgReset').disabled = !(view && index > 0);
    ['#imgSelect', '#imgDownload', '#imgSave'].forEach((id) => { $(id).disabled = !(has && view); });
    if (!drag) canvas.style.cursor = mode === 'view' ? 'pointer' : mode === 'select' ? 'crosshair' : 'default';
    $('#imgHint').textContent = !has ? '' :
      mode === 'view' ? 'Click on a person to select them. (Or press "Draw outline instead".)' :
      mode === 'select' ? 'Press and drag to draw a line all the way around the person, then press "Cut out".' :
      'Press on the person and drag. The sliders change the size and how much the colours match the new place.' +
        (cut && cut.pending ? ' Filling the empty place...' : ' Press "Apply" when it looks good.');
  }

  /* ------------------------------------------------------------ mouse / touch */
  function toImage(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  }

  /* Is this point on the PERSON'S OWN pixels (not just inside the box around them)? */
  function hitPerson(p) {
    if (!cut) return false;
    const pw = cut.person.width, ph = cut.person.height;
    for (const oy of [0, -4, 4]) {
      for (const ox of [0, -4, 4]) { // a few pixels of tolerance for fingers
        const lx = Math.floor((p.x + ox - pos.x) / scale), ly = Math.floor((p.y + oy - pos.y) / scale);
        if (lx >= 0 && ly >= 0 && lx < pw && ly < ph && cut.alpha[ly * pw + lx] > 40) return true;
      }
    }
    return false;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = toImage(e);
    if (mode === 'select') {
      lasso = [p];
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
    } else if (mode === 'move' && cut) {
      if (hitPerson(p)) {
        drag = { dx: p.x - pos.x, dy: p.y - pos.y };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
      }
    } else if (mode === 'view' && index >= 0 && !picking) {
      tap = { sx: e.clientX, sy: e.clientY, p };
    }
    render();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = toImage(e);
    if (mode === 'select' && drawing) {
      const last = lasso[lasso.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) lasso.push(p);
      render();
    } else if (mode === 'move' && drag) {
      pos = { x: p.x - drag.dx, y: p.y - drag.dy };
      render();
    } else if (mode === 'move' && cut) {
      canvas.style.cursor = hitPerson(p) ? 'grab' : 'default';
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    drawing = false;
    if (drag) {
      drag = null;
      canvas.style.cursor = 'grab';
      refreshLook(); // new place -> match the colours to it
    }
    if (tap) {
      const t = tap;
      tap = null;
      if (Math.hypot(e.clientX - t.sx, e.clientY - t.sy) < 8) pickPerson(t.p); // a click, not a drag
    }
  });
  canvas.addEventListener('pointercancel', () => { drawing = false; drag = null; tap = null; });
  window.addEventListener('resize', () => { if (index >= 0) render(); });

  /* ------------------------------------------------------------ person workflow */
  function toBlob(c) {
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  /* Starts the move mode. quickBg = fast browser fill, shown until the server's better fill arrives. */
  function enterMove(base, person, origin, maskCanvas, quickBg) {
    const id = ++cutSeq;
    const pd = person.getContext('2d').getImageData(0, 0, person.width, person.height).data;
    const alpha = new Uint8Array(person.width * person.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pd[i * 4 + 3];
    cut = {
      id, bg: quickBg, person, look: person, origin, alpha, pending: true, job: null,
      // light at the OLD place (measured once), compared later with the light at the new place
      fromStat: ringStats(base, { x: origin.x, y: origin.y, w: person.width, h: person.height }),
    };
    pos = { x: origin.x, y: origin.y };
    scale = 1;
    scaleInput.value = 1;
    mode = 'move';
    cut.job = fillBackground(base, maskCanvas, id);
    refreshLook();
  }

  /* Asks the server (LaMa) for the realistic fill of the empty place. Never throws. */
  async function fillBackground(base, maskCanvas, id) {
    try {
      const fd = new FormData();
      fd.append('file', await toBlob(base), 'image.png');
      fd.append('mask', await toBlob(maskCanvas), 'mask.png');
      const r = await upload('/api/image/inpaint/', fd);
      const filled = await dataUrlToCanvas(r.image);
      if (!cut || cut.id !== id) return; // the user cancelled or chose someone else meanwhile
      cut.bg = filled;
      if (r.engine === 'opencv' && !warnedBasic) {
        warnedBasic = true;
        toast('The LaMa model is not available, so a basic fill was used. Run "python manage.py check_ai" to see why.', true);
      }
    } catch (err) {
      if (cut && cut.id === id) toast('Server could not fill the background: ' + err.message + ' (quick fill used)', true);
    } finally {
      if (cut && cut.id === id) { cut.pending = false; refreshLook(); }
    }
  }

  /* Recolours the person for the place where they are now, then redraws. */
  function refreshLook() {
    if (cut) {
      const to = ringStats(cut.bg, { x: pos.x, y: pos.y, w: cut.person.width * scale, h: cut.person.height * scale });
      cut.look = harmonizePerson(cut.person, cut.fromStat, to, parseFloat(blendInput.value));
    }
    render();
  }

  /* The user clicked at p (image pixels): ask the server for this person's exact shape. */
  async function pickPerson(p) {
    if (picking || index < 0) return;
    picking = true;
    const base = current();
    setBusy('Finding the person you clicked...');
    try {
      const fd = new FormData();
      fd.append('file', await toBlob(base), 'image.png');
      fd.append('x', Math.round(p.x));
      fd.append('y', Math.round(p.y));
      const r = await upload('/api/image/segment/', fd, setProgress);
      const [person, maskCanvas] = await Promise.all([dataUrlToCanvas(r.person), dataUrlToCanvas(r.mask)]);
      setBusy('Getting the person ready...');
      await sleep(40);
      const m = maskFromCanvas(maskCanvas);
      const quick = cutOutFromMask(base, m.mask, m.box).bg;
      enterMove(base, person, { x: r.bbox[0], y: r.bbox[1] }, maskCanvas, quick);
    } catch (err) {
      toast(err.message, true);
    } finally {
      picking = false;
      setBusy(null);
      render();
    }
  }

  function lassoOk() {
    if (lasso.length < 8) return false;
    const xs = lasso.map((p) => p.x), ys = lasso.map((p) => p.y);
    return Math.max(...xs) - Math.min(...xs) > 20 && Math.max(...ys) - Math.min(...ys) > 20;
  }

  $('#imgSelect').addEventListener('click', () => { mode = 'select'; lasso = []; render(); });
  $('#imgClearLasso').addEventListener('click', () => { lasso = []; render(); });
  $('#imgCancelSelect').addEventListener('click', () => { mode = 'view'; lasso = []; render(); });

  /* manual outline (works without the AI packages) */
  $('#imgCut').addEventListener('click', async () => {
    if (!lassoOk()) { toast('Draw a bigger line all the way around the person.', true); return; }
    setBusy('Cutting out the person...');
    await sleep(60); // let the browser paint the overlay before the heavy work starts
    try {
      const base = current();
      const r = cutOutPerson(base, lasso);
      enterMove(base, r.person, r.origin, r.maskCanvas, r.bg);
    } catch (err) {
      toast(err.message, true);
    } finally {
      setBusy(null);
      render();
    }
  });

  scaleInput.addEventListener('input', () => {
    if (!cut) return;
    const s = parseFloat(scaleInput.value);
    // keep the person's centre where it is while resizing
    const cx = pos.x + (cut.person.width * scale) / 2;
    const cy = pos.y + (cut.person.height * scale) / 2;
    scale = s;
    pos = { x: cx - (cut.person.width * s) / 2, y: cy - (cut.person.height * s) / 2 };
    refreshLook();
  });
  blendInput.addEventListener('input', refreshLook);
  shadowBox.addEventListener('change', render);

  $('#imgApply').addEventListener('click', async () => {
    if (!cut) return;
    if (cut.pending) await withBusy('Finishing the background...', () => cut && cut.job);
    if (!cut) return;
    const merged = composePerson(cut.bg, cut.look, pos, scale, { shadow: shadowBox.checked });
    history = history.slice(0, index + 1);
    history.push(merged);
    index++;
    mode = 'view';
    cut = null;
    lasso = [];
    render();
  });
  $('#imgCancelMove').addEventListener('click', () => { mode = 'view'; cut = null; lasso = []; render(); });

  /* ------------------------------------------------------------ undo / redo / reset */
  $('#imgUndo').addEventListener('click', () => { if (index > 0) { index--; render(); } });
  $('#imgRedo').addEventListener('click', () => { if (index < history.length - 1) { index++; render(); } });
  $('#imgReset').addEventListener('click', () => { if (history.length) { index = 0; render(); } });

  /* ------------------------------------------------------------ export */
  function canvasToBlob() {
    return new Promise((resolve) => current().toBlob(resolve, 'image/png'));
  }

  $('#imgDownload').addEventListener('click', async () => {
    const blob = await canvasToBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'edited_image.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('#imgSave').addEventListener('click', async () => {
    await withBusy('Uploading to the server...', async () => {
      const blob = await canvasToBlob();
      const fd = new FormData();
      fd.append('file', blob, 'edited.png');
      fd.append('name', 'Edited image ' + new Date().toLocaleString());
      fd.append('details', JSON.stringify({ editsApplied: index, width: current().width, height: current().height }));
      await upload('/api/image/save/', fd, setProgress);
      toast('Project saved on the server.');
      if (window.refreshProjects) window.refreshProjects();
    });
  });

  render();
})();
