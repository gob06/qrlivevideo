const mainEl = document.getElementById('adm-main');

function showBootError(title, detail) {
  if (!mainEl) return;
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.style.maxWidth = '680px';
  wrap.style.margin = '24px auto';

  const h = document.createElement('h2');
  h.style.margin = '0 0 8px';
  h.textContent = title;

  const p = document.createElement('p');
  p.className = 'page-meta';
  p.style.margin = '0 0 12px';
  p.textContent = detail;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = 'Reload Console';
  btn.addEventListener('click', () => window.location.reload());

  wrap.appendChild(h);
  wrap.appendChild(p);
  wrap.appendChild(btn);
  mainEl.innerHTML = '';
  mainEl.appendChild(wrap);
}

const cfgEl = document.getElementById('app-config');
if (!cfgEl || !cfgEl.textContent || !cfgEl.textContent.trim()) {
  showBootError('Studio Configuration Missing', 'The server did not render #app-config JSON. Check server PHP logs.');
} else {
  const v = new URL(import.meta.url).searchParams.get('v') || '';
  const target = './admin.js' + (v ? `?v=${encodeURIComponent(v)}` : '');
  import(target).catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    showBootError(
      'Failed to Load Studio Console Module',
      `${msg}. Verify all files in /public/assets/js/ are deployed and hard-refresh (Ctrl+Shift+R).`
    );
  });
}
