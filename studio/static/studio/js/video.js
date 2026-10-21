/* Video tab: pick a video, split it into clips, drag to re-order, export on the server. */
(() => {
  const player = $('#videoPlayer');
  const list = $('#videoList');
  let file = null;
  let duration = 0;
  let segs = [];        // { id, start, end }  (seconds in the ORIGINAL video)
  let nextId = 1;
  let previewEnd = null;

  function render() {
    list.innerHTML = '';
    segs.forEach((s, i) => {
      const li = document.createElement('li');
      li.dataset.id = s.id;
      li.innerHTML = `
        <span class="handle" draggable="true" title="Drag to reorder">☰</span>
        <div class="item-info"><strong></strong><span class="muted"></span></div>
        <div class="actions">
          <button class="btn small" data-act="play" title="Preview this clip">▶</button>
          <button class="btn small" data-act="up" title="Move up">↑</button>
          <button class="btn small" data-act="down" title="Move down">↓</button>
          <button class="btn small" data-act="remove" title="Remove">✕</button>
        </div>`;
      li.querySelector('strong').textContent = `Clip ${i + 1}`;
      li.querySelector('.muted').textContent =
        `${formatTime(s.start)} - ${formatTime(s.end)}  (${(s.end - s.start).toFixed(1)} s)`;
      list.appendChild(li);
    });
  }

  makeSortable(list, (ids) => { reorderByIds(segs, ids); render(); hideResult(); });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    const seg = segs.find((s) => String(s.id) === id);
    if (btn.dataset.act === 'play' && seg) {
      player.currentTime = seg.start;
      previewEnd = seg.end;
      player.play();
      return;
    }
    if (btn.dataset.act === 'up') moveItem(segs, id, -1);
    if (btn.dataset.act === 'down') moveItem(segs, id, 1);
    if (btn.dataset.act === 'remove') {
      if (segs.length === 1) { toast('At least one clip is needed.', true); return; }
      segs = segs.filter((s) => String(s.id) !== id);
    }
    render();
    hideResult();
  });

  // stop the preview of a single clip at its end time
  player.addEventListener('timeupdate', () => {
    if (previewEnd !== null && player.currentTime >= previewEnd) { previewEnd = null; player.pause(); }
  });
  player.addEventListener('play', () => { if (previewEnd !== null && player.currentTime >= previewEnd) previewEnd = null; });

  $('#videoInput').addEventListener('change', (e) => {
    const picked = e.target.files[0];
    e.target.value = '';
    if (!picked) return;
    file = picked;
    hideResult();
    if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
    const url = URL.createObjectURL(picked);
    player.dataset.url = url;
    player.src = url;
    $('#videoInfo').textContent = `${picked.name} (${formatSize(picked.size)})`;
  });

  player.addEventListener('loadedmetadata', () => {
    duration = player.duration;
    segs = [{ id: nextId++, start: 0, end: duration }];
    previewEnd = null;
    player.classList.remove('hidden');
    $('#videoEmpty').classList.add('hidden');
    $('#videoTools').classList.remove('hidden');
    render();
  });
  player.addEventListener('error', () => {
    if (file) toast('This browser cannot play that video. Try an MP4 (H.264) file.', true);
  });

  $('#videoSplitEqual').addEventListener('click', () => {
    const n = parseInt($('#videoParts').value, 10);
    const len = duration / n;
    segs = Array.from({ length: n }, (_, i) => ({
      id: nextId++, start: i * len, end: i === n - 1 ? duration : (i + 1) * len,
    }));
    render();
    hideResult();
  });

  $('#videoSplitHere').addEventListener('click', () => {
    const t = player.currentTime;
    const i = segs.findIndex((s) => t > s.start + 0.5 && t < s.end - 0.5);
    if (i < 0) { toast('Move the video to a time inside a clip (at least 0.5 s from its ends).', true); return; }
    const s = segs[i];
    segs.splice(i, 1, { id: nextId++, start: s.start, end: t }, { id: nextId++, start: t, end: s.end });
    render();
    hideResult();
  });

  function hideResult() { $('#videoResult').classList.add('hidden'); }

  $('#videoExport').addEventListener('click', async () => {
    if (!file || !segs.length) return;
    player.pause();
    await withBusy('Uploading the video...', async () => {
      const fd = new FormData();
      fd.append('video', file, file.name);
      fd.append('segments', JSON.stringify(segs.map((s) => ({ start: s.start, end: s.end }))));
      fd.append('name', `Video edit (${segs.length} clips)`);
      const project = await upload('/api/video/export/', fd, (f) => {
        if (f === null) { $('#busyText').textContent = 'Cutting and joining the clips on the server (can take a minute)...'; setProgress(null); }
        else { setProgress(f); }
      });
      // download as a blob so the preview can be scrubbed freely
      const blob = await (await fetch(project.url)).blob();
      const blobUrl = URL.createObjectURL(blob);
      $('#videoResultPlayer').src = blobUrl;
      $('#videoDownload').href = blobUrl;
      $('#videoResult').classList.remove('hidden');
      toast('Done! Your new video is ready below.');
      if (window.refreshProjects) window.refreshProjects();
    });
  });
})();
