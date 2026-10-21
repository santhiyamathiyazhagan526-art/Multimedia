/* "My projects" tab: list of everything saved in PostgreSQL, with delete. */
(() => {
  const list = $('#projectList');
  const ICONS = { image: '🖼️', audio: '🎵', video: '🎬' };

  async function refresh() {
    try {
      const data = await requestJSON('/api/projects/');
      list.innerHTML = '';
      data.projects.forEach((p) => {
        const li = document.createElement('li');
        li.innerHTML = `
          <span class="icon"></span>
          <div class="item-info"><strong></strong><span class="muted"></span></div>
          <a class="btn small" target="_blank" rel="noopener">Open</a>
          <button class="btn small">Delete</button>`;
        li.querySelector('.icon').textContent = ICONS[p.type] || '📄';
        li.querySelector('strong').textContent = p.name;
        li.querySelector('.muted').textContent = new Date(p.created_at).toLocaleString();
        const open = li.querySelector('a');
        if (p.url) open.href = p.url; else open.remove();
        li.querySelector('button').addEventListener('click', async () => {
          if (!confirm('Delete this project?')) return;
          try {
            await requestJSON(`/api/projects/${p.id}/`, { method: 'DELETE' });
            refresh();
          } catch (err) { toast(err.message, true); }
        });
        list.appendChild(li);
      });
      $('#projectEmpty').classList.toggle('hidden', data.projects.length > 0);
    } catch (err) {
      toast(err.message, true);
    }
  }

  window.refreshProjects = refresh;
  refresh();
})();
