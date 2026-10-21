/* Small helpers used by every tab. */
const $ = (selector, root = document) => root.querySelector(selector);

function csrfToken() {
  return $('[name=csrfmiddlewaretoken]').value; // Django's security token (hidden input)
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

/* Busy overlay: setBusy('text') shows it, setBusy(null) hides it. */
function setBusy(text) {
  const box = $('#busy');
  if (!text) { box.classList.add('hidden'); return; }
  $('#busyText').textContent = text;
  box.classList.remove('hidden');
  setProgress(null);
}

/* setProgress(0..1) shows a real percentage, setProgress(null) shows the moving bar. */
function setProgress(fraction) {
  const bar = $('#busyBar');
  if (fraction === null) {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = Math.round(fraction * 100) + '%';
  }
}

/* Runs a function while the busy overlay is visible; shows errors as a red toast. */
async function withBusy(text, job) {
  setBusy(text);
  try {
    return await job();
  } catch (err) {
    toast(err.message || String(err), true);
    return undefined;
  } finally {
    setBusy(null);
  }
}

function handleSessionEnd(status) {
  if (status === 401) window.location.href = '/login/';
}

/* Upload files with a progress bar (XMLHttpRequest, because fetch cannot report upload progress). */
function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-CSRFToken', csrfToken());
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.upload.onload = () => { if (onProgress) onProgress(null); };
    xhr.onerror = () => reject(new Error('Cannot reach the server. Is it running?'));
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      handleSessionEnd(xhr.status);
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(new Error((data && data.error) || `Server error (${xhr.status})`));
    };
    xhr.send(formData);
  });
}

/* Normal request that returns JSON. */
async function requestJSON(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'X-CSRFToken': csrfToken(), ...(options.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  handleSessionEnd(res.status);
  if (!res.ok) throw new Error((data && data.error) || `Server error (${res.status})`);
  return data;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function formatSize(bytes) {
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
}
