/* Drag-and-drop re-ordering for a <ul>.
 *
 * Every <li> needs data-id and a ".handle" element with draggable="true".
 * While you drag, the list items move live. When you drop, onChange(ids) is called
 * with the ids in the new order.
 */
function makeSortable(list, onChange) {
  let dragging = null;

  list.addEventListener('dragstart', (e) => {
    const handle = e.target.closest ? e.target.closest('.handle') : null;
    if (!handle) return;
    dragging = handle.closest('li');
    dragging.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.dataset.id);
    e.dataTransfer.setDragImage(dragging, 20, 20);
  });

  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const others = Array.from(list.querySelectorAll('li:not(.dragging)'));
    const next = others.find((li) => {
      const box = li.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (next) list.insertBefore(dragging, next);
    else list.appendChild(dragging);
  });

  list.addEventListener('drop', (e) => e.preventDefault());

  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    onChange(Array.from(list.querySelectorAll('li')).map((li) => li.dataset.id));
  });
}

/* Helper for the ↑ ↓ buttons: moves the item with this id by delta places inside array. */
function moveItem(array, id, delta) {
  const from = array.findIndex((item) => String(item.id) === String(id));
  const to = from + delta;
  if (from < 0 || to < 0 || to >= array.length) return;
  const [item] = array.splice(from, 1);
  array.splice(to, 0, item);
}

/* Reorders array so it matches the list of ids. */
function reorderByIds(array, ids) {
  const byId = new Map(array.map((item) => [String(item.id), item]));
  const sorted = ids.map((id) => byId.get(String(id))).filter(Boolean);
  array.splice(0, array.length, ...sorted);
}
