/* Audio tab: pick files, play them, drag to re-order, combine on the server. */
(() => {
  const list = $('#audioList');
  let clips = [];   // { id, file, url }
  let nextId = 1;

  function render() {
    list.innerHTML = '';
    clips.forEach((c, i) => {
      const li = document.createElement('li');
      li.dataset.id = c.id;
      li.innerHTML = `
        <span class="handle" draggable="true" title="Drag to reorder">☰</span>
        <div class="item-info">
          <strong></strong>
          <span class="muted"></span><br>
          <audio controls preload="metadata"></audio>
        </div>
        <div class="actions">
          <button class="btn small" data-act="up" title="Move up">↑</button>
          <button class="btn small" data-act="down" title="Move down">↓</button>
          <button class="btn small" data-act="remove" title="Remove">✕</button>
        </div>`;
      li.querySelector('strong').textContent = `${i + 1}. ${c.file.name}`;
      li.querySelector('.muted').textContent = formatSize(c.file.size);
      li.querySelector('audio').src = c.url;
      list.appendChild(li);
    });
    $('#audioEmpty').classList.toggle('hidden', clips.length > 0);
    $('#audioCount').textContent = clips.length ? `${clips.length} clip(s)` : '';
    $('#audioMerge').disabled = clips.length === 0;
  }

  // only one clip plays at a time
  list.addEventListener('play', (e) => {
    list.querySelectorAll('audio').forEach((a) => { if (a !== e.target) a.pause(); });
    $('#audioResultPlayer').pause();
  }, true);

  makeSortable(list, (ids) => { reorderByIds(clips, ids); render(); hideResult(); });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    if (btn.dataset.act === 'up') moveItem(clips, id, -1);
    if (btn.dataset.act === 'down') moveItem(clips, id, 1);
    if (btn.dataset.act === 'remove') {
      const gone = clips.find((c) => String(c.id) === id);
      if (gone) URL.revokeObjectURL(gone.url);
      clips = clips.filter((c) => String(c.id) !== id);
    }
    render();
    hideResult();
  });

  $('#audioInput').addEventListener('change', (e) => {
    Array.from(e.target.files).forEach((file) => clips.push({ id: nextId++, file, url: URL.createObjectURL(file) }));
    e.target.value = '';
    render();
    hideResult();
  });

  function hideResult() { $('#audioResult').classList.add('hidden'); }

  $('#audioMerge').addEventListener('click', async () => {
    await withBusy('Uploading the clips...', async () => {
      const fd = new FormData();
      clips.forEach((c) => fd.append('clips', c.file, c.file.name)); // same order as the list on screen
      fd.append('name', `Audio mix (${clips.length} clips)`);
      const project = await upload('/api/audio/merge/', fd, (f) => {
        if (f === null) { $('#busyText').textContent = 'Joining the clips on the server...'; setProgress(null); }
        else { setProgress(f); }
      });
      $('#audioResultPlayer').src = project.url;
      $('#audioDownload').href = project.url;
      $('#audioResult').classList.remove('hidden');
      toast('Audio merged! Press play to listen.');
      if (window.refreshProjects) window.refreshProjects();
    });
  });

  render();
})();
