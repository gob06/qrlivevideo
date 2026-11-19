import { renderBrandedQR, renderBrandedQRSvg, checkQrSafety, testScanCanvas, downloadBlob } from './qr-brand.js?v=20261119';
import { sanitizeIceServers, formatAspectLabel, computeVideoFrameMetrics } from './webrtc-common.js?v=20261119';
import { createWallTile, updateWallTileAppearance, attachStreamToWallTile } from './wall-renderer.js?v=20261119';

const cfg = JSON.parse(document.getElementById('app-config').textContent);
const mainEl = document.getElementById('adm-main');
const modalBackdrop = document.getElementById('adm-modal-backdrop');
const modalEl = document.getElementById('adm-modal');
const toastStack = document.getElementById('adm-toast-stack');

let currentRoute = cfg.initialRoute || '/admin/events';
let pollTimer = null;
let durationTimer = null;
let selectedSlot = null;
let activeEventId = null;
let lastStateVersion = null;
let lastStateData = null;
let soundAlertsEnabled = false;
let lastAlertHash = '';
let frameCheckCleanup = null;

// Private Preview / Audio Monitor WebRTC state
let previewPeer = null; // { pid, pc, stream, audioCtx, analyser, source, rafId }
let previewPollTimer = null;
let previewAudioEnabled = false;
let listeningPid = null;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolvePublicUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, window.location.origin);
    const cur = new URL(window.location.origin);
    const rawLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname);
    const curLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(cur.hostname);
    if (rawLocal && !curLocal) {
      return cur.origin + u.pathname + u.search + u.hash;
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function normalizeEventUrls(data) {
  if (!data) return data;
  if (data.joinUrl) data.joinUrl = resolvePublicUrl(data.joinUrl);
  if (data.wallUrl) data.wallUrl = resolvePublicUrl(data.wallUrl);
  return data;
}

function buildMonitorWallSrc(ev, tag) {
  const uid = Math.random().toString(36).slice(2, 8);
  return `/wall/${encodeURIComponent(ev.slug)}?key=${encodeURIComponent(ev.wall_key)}&monitor=1&mid=${encodeURIComponent(`${tag}_${cfg.user.id}_${uid}`)}`;
}

function pokeWallIframe(iframeEl) {
  try {
    iframeEl?.contentWindow?.postMessage({ type: 'qrlw_poll_now' }, window.location.origin);
  } catch {}
}

function toast(msg) {
  const div = document.createElement('div');
  div.className = 'adm-toast';
  div.textContent = msg;
  toastStack.appendChild(div);
  setTimeout(() => div.remove(), 4200);
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 180);
  } catch {}
}

async function api(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (opts.method && opts.method !== 'GET') {
    headers.set('X-CSRF-Token', cfg.csrfToken);
  }
  if (opts.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const resp = await fetch(url, { ...opts, headers, cache: 'no-store' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `Request failed (${resp.status})`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

function openModal(html) {
  modalEl.innerHTML = html;
  modalBackdrop.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
  modalEl.innerHTML = '';
}

modalBackdrop.addEventListener('click', (ev) => {
  if (ev.target === modalBackdrop) closeModal();
});

async function openTurnConfigModal(onSaved = null) {
  let st = null;
  try {
    st = await api('/api/admin/turn-config');
  } catch (err) {
    toast(err.message);
    return;
  }

  const initMode = st.mode === 'static' ? 'static' : 'cloudflare';
  openModal(`
    <h2 style="margin:0;">TURN / ICE Server Configuration</h2>
    <p class="page-meta" style="margin:0;">Required for phones on cellular networks or strict NATs. Credentials stay server-side.</p>
    <div id="turn-cfg-status" class="adm-alert ${st.configured ? 'adm-alert-ok' : 'adm-alert-warn'}" style="margin:4px 0;">
      ${st.configured
        ? `TURN active (${esc(st.mode === 'cloudflare' ? `Cloudflare ${st.cf_key_preview}` : st.turn_url)} · source: ${esc(st.source.toUpperCase())})`
        : esc(st.error ? `Error: ${st.error}` : 'TURN not configured (STUN only).')}
    </div>
    <div id="turn-cfg-err" class="adm-alert adm-alert-error" hidden></div>
    <form id="turn-cfg-form" class="adm-auth-form">
      <div class="seg-tabs" id="turn-mode-tabs">
        <button type="button" class="seg-tab ${initMode === 'cloudflare' ? 'active' : ''}" data-tmode="cloudflare">Cloudflare Realtime TURN</button>
        <button type="button" class="seg-tab ${initMode === 'static' ? 'active' : ''}" data-tmode="static">Static TURN (coturn/Metered)</button>
      </div>
      <div id="turn-pane-cf" ${initMode === 'cloudflare' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:10px;">
        <div class="page-meta">In Cloudflare Dashboard: go to <strong>Realtime → TURN</strong> (not Realtime SFU / Apps and not Account ID), create a TURN key, and copy its <strong>TURN Token ID</strong> and <strong>API Token</strong>.</div>
        <label class="field">
          <span>TURN Token ID (CLOUDFLARE_TURN_KEY_ID)</span>
          <input type="text" id="tc-cf-key" placeholder="${st.cf_key_preview ? `Current: ${esc(st.cf_key_preview)}` : '32-char TURN Token ID'}" autocomplete="off">
        </label>
        <label class="field">
          <span>API Token (CLOUDFLARE_TURN_API_TOKEN)</span>
          <input type="password" id="tc-cf-token" placeholder="${st.has_cf_token ? 'Saved — paste new token to change' : '64-char API Token'}" autocomplete="off">
        </label>
        <label class="field">
          <span>Credential TTL (seconds)</span>
          <input type="number" id="tc-cf-ttl" min="60" max="86400" value="${Number(st.cf_ttl || 86400)}">
        </label>
      </div>
      <div id="turn-pane-static" ${initMode === 'static' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:10px;">
        <label class="field">
          <span>TURN URL(s) (comma-separated)</span>
          <input type="text" id="tc-st-url" value="${esc(st.turn_url || '')}" placeholder="turns:turn.example.com:5349?transport=tcp">
        </label>
        <label class="field">
          <span>TURN Username</span>
          <input type="text" id="tc-st-user" value="${esc(st.turn_user || '')}" autocomplete="off">
        </label>
        <label class="field">
          <span>TURN Credential / Password</span>
          <input type="password" id="tc-st-pass" placeholder="${st.has_turn_pass ? 'Saved — paste new password to change' : 'Static TURN password'}" autocomplete="off">
        </label>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:6px;">
        <div>
          ${st.source === 'db' ? '<button type="button" class="btn btn-ghost btn-sm" id="tc-clear-btn">Clear Saved Override</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn btn-secondary" id="tc-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="tc-save-btn">Verify &amp; Save</button>
        </div>
      </div>
    </form>
  `);

  let activeMode = initMode;
  const cfPane = document.getElementById('turn-pane-cf');
  const stPane = document.getElementById('turn-pane-static');
  const errBox = document.getElementById('turn-cfg-err');
  const saveBtn = document.getElementById('tc-save-btn');

  document.getElementById('turn-mode-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-tmode]');
    if (!btn) return;
    activeMode = btn.dataset.tmode;
    document.querySelectorAll('#turn-mode-tabs .seg-tab').forEach((b) => b.classList.toggle('active', b === btn));
    cfPane.hidden = activeMode !== 'cloudflare';
    stPane.hidden = activeMode !== 'static';
    errBox.hidden = true;
  });

  document.getElementById('tc-cancel').addEventListener('click', closeModal);

  document.getElementById('tc-clear-btn')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/turn-config', { method: 'POST', json: { action: 'clear' } });
      toast(res.message || 'TURN override cleared');
      closeModal();
      if (onSaved) onSaved();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  document.getElementById('turn-cfg-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = activeMode === 'cloudflare' ? 'Testing Cloudflare...' : 'Saving...';
    try {
      const payload = activeMode === 'cloudflare'
        ? {
            mode: 'cloudflare',
            cf_key_id: document.getElementById('tc-cf-key').value.trim(),
            cf_api_token: document.getElementById('tc-cf-token').value.trim(),
            cf_ttl: Number(document.getElementById('tc-cf-ttl').value || 86400),
          }
        : {
            mode: 'static',
            turn_url: document.getElementById('tc-st-url').value.trim(),
            turn_user: document.getElementById('tc-st-user').value.trim(),
            turn_pass: document.getElementById('tc-st-pass').value.trim(),
          };
      const res = await api('/api/admin/turn-config', { method: 'POST', json: payload });
      toast(res.message || 'TURN settings saved');
      closeModal();
      if (onSaved) onSaved();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Verify & Save';
    }
  });
}

async function openTermsOfServiceModal() {
  let st = null;
  try {
    st = await api('/api/admin/terms-of-service');
  } catch (err) {
    toast(err.message);
    return;
  }

  openModal(`
    <h2 style="margin:0;">Edit Terms of Service</h2>
    <p class="page-meta" style="margin:0;">Shown when audience members tap <strong>Terms of Service</strong> on the Join the Live Screen page.</p>
    <div id="tos-status" class="adm-alert ${st.is_custom ? 'adm-alert-ok' : 'adm-alert-warn'}" style="margin:4px 0;">
      ${st.is_custom ? 'Custom Terms of Service active.' : 'Currently using default Terms of Service.'}
    </div>
    <div id="tos-err" class="adm-alert adm-alert-error" hidden></div>
    <form id="tos-form" class="adm-auth-form">
      <label class="field">
        <span>Terms of Service Text</span>
        <textarea id="tos-textarea" rows="11" maxlength="10000" required style="width:100%;resize:vertical;line-height:1.5;font-family:inherit;">${esc(st.terms_of_service || '')}</textarea>
      </label>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:6px;">
        <div>
          ${st.is_custom ? '<button type="button" class="btn btn-ghost btn-sm" id="tos-reset-btn">Reset to Default</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn btn-secondary" id="tos-cancel-btn">Cancel</button>
          <button type="submit" class="btn btn-primary" id="tos-save-btn">Save Terms</button>
        </div>
      </div>
    </form>
  `);

  const errBox = document.getElementById('tos-err');
  const saveBtn = document.getElementById('tos-save-btn');
  const textEl = document.getElementById('tos-textarea');

  document.getElementById('tos-cancel-btn').addEventListener('click', closeModal);

  document.getElementById('tos-reset-btn')?.addEventListener('click', async () => {
    errBox.hidden = true;
    try {
      const res = await api('/api/admin/terms-of-service', { method: 'POST', json: { action: 'reset' } });
      toast(res.message || 'Terms of Service reset to default');
      closeModal();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  document.getElementById('tos-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const res = await api('/api/admin/terms-of-service', {
        method: 'POST',
        json: { terms_of_service: textEl.value },
      });
      toast(res.message || 'Terms of Service updated');
      closeModal();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Terms';
    }
  });
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateNavActive(route) {
  const pathOnly = String(route || '').split('?')[0];
  document.querySelectorAll('.adm-nav-link').forEach((link) => {
    const target = link.getAttribute('data-nav');
    const isMatch = pathOnly === target || (target === '/admin/events' && pathOnly.startsWith('/admin/events'));
    link.classList.toggle('active', isMatch);
  });
}

function stopBackgroundLoops() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
  if (frameCheckCleanup) {
    try { frameCheckCleanup(); } catch {}
    frameCheckCleanup = null;
  }
  stopPreviewSession(false);
}

function navigate(path, push = true) {
  stopBackgroundLoops();
  currentRoute = path;
  if (push) history.pushState({}, '', path);
  updateNavActive(path);
  renderRoute();
}

window.addEventListener('popstate', () => {
  currentRoute = window.location.pathname + window.location.search;
  stopBackgroundLoops();
  updateNavActive(currentRoute);
  renderRoute();
});

document.addEventListener('click', (ev) => {
  const link = ev.target.closest('a[data-nav]');
  if (link) {
    ev.preventDefault();
    navigate(link.getAttribute('data-nav'));
  }
});

document.getElementById('adm-logout-all-btn').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout-everywhere', { method: 'POST' });
    window.location.href = '/admin/login';
  } catch (err) {
    toast(err.message);
  }
});

// ---------------- PRIVATE PREVIEW / LISTEN WEBRTC ----------------

async function stopPreviewSession(notifyServer = true) {
  if (previewPollTimer) { clearInterval(previewPollTimer); previewPollTimer = null; }
  if (previewPeer) {
    if (previewPeer.rafId) cancelAnimationFrame(previewPeer.rafId);
    try { previewPeer.pc.close(); } catch {}
    try { previewPeer.audioCtx?.close(); } catch {}
    previewPeer = null;
  }
  listeningPid = null;
  if (notifyServer && activeEventId) {
    api(`/api/admin/events/${activeEventId}/wall-action`, {
      method: 'POST',
      json: { action: 'preview_stop' },
    }).catch(() => {});
  }
}

async function startPrivatePreview(eventId, participantId, { videoEl = null, tile = null, meterFillEl, unmuteAudio = false }) {
  await stopPreviewSession(false);
  listeningPid = unmuteAudio ? participantId : null;
  previewAudioEnabled = unmuteAudio;

  await api(`/api/admin/events/${eventId}/wall-action`, {
    method: 'POST',
    json: { action: 'preview_start', participant_id: participantId },
  });

  const pc = new RTCPeerConnection({ iceServers: sanitizeIceServers(cfg.iceServers) });
  const entry = { pid: participantId, pc, stream: null, pendingCandidates: [], audioCtx: null, analyser: null, rafId: null };
  previewPeer = entry;

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    entry.stream = stream;
    const targetVideo = tile ? tile.video : videoEl;
    if (tile) {
      attachStreamToWallTile(tile, stream);
    } else if (videoEl) {
      videoEl.srcObject = stream;
    }
    if (targetVideo) {
      targetVideo.muted = !previewAudioEnabled;
      targetVideo.play().catch(() => {});
    }
    if (meterFillEl && stream.getAudioTracks().length > 0) {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        entry.audioCtx = audioCtx;
        entry.analyser = analyser;
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (previewPeer !== entry) return;
          analyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          const avg = sum / buf.length;
          const pct = Math.min(100, Math.round((avg / 95) * 100));
          meterFillEl.style.width = `${pct}%`;
          meterFillEl.style.background = pct > 80 ? '#ef4444' : pct > 55 ? '#d97706' : '#16a34a';
          entry.rafId = requestAnimationFrame(tick);
        };
        entry.rafId = requestAnimationFrame(tick);
      } catch {}
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      api(`/api/admin/events/${eventId}/preview-signal`, {
        method: 'POST',
        json: { participant_id: participantId, type: 'candidate', payload: ev.candidate.toJSON() },
      }).catch(() => {});
    }
  };

  previewPollTimer = setInterval(async () => {
    if (previewPeer !== entry) return;
    try {
      const res = await api(`/api/admin/events/${eventId}/preview-poll`);
      for (const sig of res.signals || []) {
        if (sig.participant_id !== participantId) continue;
        if (sig.type === 'offer' && sig.payload) {
          await pc.setRemoteDescription(new RTCSessionDescription(sig.payload));
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          await api(`/api/admin/events/${eventId}/preview-signal`, {
            method: 'POST',
            json: { participant_id: participantId, type: 'answer', payload: { type: ans.type, sdp: ans.sdp } },
          });
          for (const c of entry.pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c));
          entry.pendingCandidates = [];
        } else if (sig.type === 'candidate' && sig.payload) {
          if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(sig.payload));
          else entry.pendingCandidates.push(sig.payload);
        }
      }
    } catch {}
  }, 650);
}

// ---------------- ROUTE DISPATCH ----------------

function renderRoute() {
  const pathOnly = String(currentRoute || '').split('?')[0];
  const evMatch = pathOnly.match(/^\/admin\/events\/(\d+)$/);
  const monMatch = pathOnly.match(/^\/admin\/events\/(\d+)\/monitor$/);
  mainEl.classList.toggle('is-studio-fit', Boolean(evMatch));
  mainEl.classList.toggle('is-monitor-fit', Boolean(monMatch));
  if (monMatch) {
    renderMonitorView(Number(monMatch[1]));
  } else if (evMatch) {
    renderEventStudioView(Number(evMatch[1]));
  } else if (pathOnly === '/admin/frame-check') {
    renderFrameCheckView();
  } else if (pathOnly === '/admin/images') {
    renderImageBankView();
  } else if (pathOnly === '/admin/accounts') {
    renderAccountsView();
  } else if (pathOnly === '/admin/audit') {
    renderAuditView();
  } else {
    renderEventsListView();
  }
}

// ---------------- VIEW: EVENTS LIST ----------------

async function renderEventsListView() {
  activeEventId = null;
  const canCreate = ['super_admin', 'host'].includes(cfg.user.role);
  mainEl.innerHTML = `<div class="adm-loading">Loading events...</div>`;
  try {
    const data = await api('/api/admin/events');
    const events = data.events || [];
    mainEl.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Events</h1>
          <div class="page-meta">${events.length} event(s) available for your account</div>
        </div>
        <div class="page-actions">
          ${canCreate ? '<button type="button" class="btn btn-secondary" id="events-tos-btn">Terms of Service</button>' : ''}
          ${canCreate ? '<button type="button" class="btn btn-primary" id="new-event-btn">Create Event</button>' : ''}
        </div>
      </div>
      ${events.length === 0 ? `
        <div class="panel">
          <p style="margin:0 0 12px;color:var(--text-secondary);">No events created yet. Create your first live wall event to generate a QR code and OBS URL.</p>
          ${canCreate ? '<button type="button" class="btn btn-primary" id="empty-create-btn">Create First Event</button>' : ''}
        </div>
      ` : `
        <div class="events-grid">
          ${events.map((ev) => `
            <article class="event-card">
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
                <h2 class="event-card-title">${esc(ev.title)}</h2>
                <span class="${ev.status === 'active' ? 'status-text-green' : 'status-text-amber'}" style="font-size:12px;">${ev.status === 'active' ? 'ACTIVE' : 'CLOSED'}</span>
              </div>
              <div class="page-meta tabular">
                /${esc(ev.slug)} · ${ev.onair_count} on air · ${ev.waiting_count} waiting · ${esc(ev.layout)}
              </div>
              <div class="event-card-actions">
                <a href="/admin/events/${ev.id}" data-nav="/admin/events/${ev.id}" class="btn btn-primary btn-sm">Control Studio</a>
                <a href="/admin/events/${ev.id}/monitor" data-nav="/admin/events/${ev.id}/monitor" class="btn btn-secondary btn-sm">Monitor</a>
                <a href="/admin/events/${ev.id}/print-qr" target="_blank" class="btn btn-ghost btn-sm">Print QR</a>
              </div>
            </article>
          `).join('')}
        </div>
      `}
    `;

    const openCreate = () => {
      openModal(`
        <h2 style="margin:0;">Create New Event</h2>
        <form id="create-event-form" class="adm-auth-form">
          <label class="field">
            <span>Event Title *</span>
            <input type="text" id="ce-title" required maxlength="120" placeholder="e.g. Summer Stage Keynote">
          </label>
          <label class="field">
            <span>URL Slug (auto-generated if blank)</span>
            <input type="text" id="ce-slug" maxlength="80" placeholder="summer-stage-keynote">
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <label class="field">
              <span>Default Layout</span>
              <select id="ce-layout">
                <option value="single">Single (1 feed)</option>
                <option value="split2">Split 2 (side by side)</option>
                <option value="grid4">Grid 4 (2x2)</option>
                <option value="pip">Picture-in-Picture</option>
              </select>
            </label>
            <label class="field">
              <span>Max Participants</span>
              <input type="number" id="ce-max" value="100" min="2" max="500">
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px;">
            <button type="button" class="btn btn-ghost" id="ce-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Event</button>
          </div>
        </form>
      `);
      document.getElementById('ce-cancel').addEventListener('click', closeModal);
      document.getElementById('create-event-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await api('/api/admin/events', {
            method: 'POST',
            json: {
              title: document.getElementById('ce-title').value,
              slug: document.getElementById('ce-slug').value,
              layout: document.getElementById('ce-layout').value,
              max_participants: Number(document.getElementById('ce-max').value),
            },
          });
          closeModal();
          toast('Event created');
          navigate(`/admin/events/${res.event.id}`);
        } catch (err) {
          toast(err.message);
        }
      });
    };

    document.getElementById('events-tos-btn')?.addEventListener('click', openTermsOfServiceModal);
    document.getElementById('new-event-btn')?.addEventListener('click', openCreate);
    document.getElementById('empty-create-btn')?.addEventListener('click', openCreate);
  } catch (err) {
    mainEl.innerHTML = `<div class="adm-alert adm-alert-error">${esc(err.message)}</div>`;
  }
}

// ---------------- VIEW: EVENT CONTROL STUDIO ----------------

async function renderEventStudioView(eventId) {
  activeEventId = eventId;
  lastStateVersion = null;
  selectedSlot = null;
  let filterMode = 'all';
  let searchQuery = '';
  let qrDraft = null;
  let lastQrRenderSig = '';
  const canHost = ['super_admin', 'host'].includes(cfg.user.role);
  const isSuper = cfg.user.role === 'super_admin';

  mainEl.innerHTML = `<div class="adm-loading">Loading event studio...</div>`;

  let initial;
  try {
    initial = normalizeEventUrls(await api(`/api/admin/events/${eventId}/state`));
  } catch (err) {
    mainEl.innerHTML = `<div class="adm-alert adm-alert-error">${esc(err.message)}</div>`;
    return;
  }

  lastStateData = initial;
  lastStateVersion = Number(initial.event.state_version);
  qrDraft = extractQrDraft(initial.event);

  function extractQrDraft(ev) {
    return {
      logo_image_id: ev.logo_image_id ? Number(ev.logo_image_id) : null,
      logo_filename: ev.logo_filename || null,
      qr_logo_shape: ev.qr_logo_shape || 'square',
      qr_logo_fit: ev.qr_logo_fit || 'contain',
      qr_logo_scale: Number(ev.qr_logo_scale || 18),
      qr_logo_padding: Number(ev.qr_logo_padding ?? 8),
      qr_logo_bg: ev.qr_logo_bg || '#ffffff',
      qr_fg: ev.qr_fg || '#000000',
      qr_bg: ev.qr_bg || '#ffffff',
    };
  }

  mainEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1 id="st-title">${esc(initial.event.title)}</h1>
        <div class="page-meta" id="st-meta"></div>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="copy-join-btn">Copy Join URL</button>
        <button type="button" class="btn btn-secondary btn-sm" id="copy-wall-btn">Copy OBS Wall URL</button>
        <a href="/admin/events/${eventId}/print-qr" target="_blank" class="btn btn-secondary btn-sm">Printable QR</a>
        <a href="/admin/events/${eventId}/monitor" data-nav="/admin/events/${eventId}/monitor" class="btn btn-primary btn-sm">Live Monitor</a>
      </div>
    </div>

    <div class="conflict-notice" id="st-conflict-notice" hidden></div>

    <div class="studio-layout">
      <div class="studio-col">
        <!-- Wall Control & Slots -->
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Wall Control &amp; Active Slots</h2>
            <span class="page-meta">Shortcuts: 1-4 select slot · C clear · B blackout</span>
          </div>

          <div class="slots-grid" id="st-slots-grid"></div>

          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;">
            ${canHost ? `
              <label class="field" style="flex-direction:row;align-items:center;gap:6px;">
                <span>Layout</span>
                <select id="st-layout" style="min-height:32px;width:auto;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
                  <option value="single">Single</option>
                  <option value="split2">Split 2</option>
                  <option value="grid4">Grid 4</option>
                  <option value="pip">PiP</option>
                </select>
              </label>
              <label class="field" style="flex-direction:row;align-items:center;gap:6px;">
                <span>Max Feeds</span>
                <select id="st-max-feeds" style="min-height:32px;width:auto;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
              </label>
              <label class="field" style="flex-direction:row;align-items:center;gap:6px;">
                <span>Fit</span>
                <select id="st-fit-mode" style="min-height:32px;width:auto;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
                  <option value="fit">Fit (no crop)</option>
                  <option value="fill">Fill (crops)</option>
                  <optgroup label="Advanced">
                    <option value="stretch">Stretch</option>
                  </optgroup>
                </select>
              </label>
              <label class="field" style="flex-direction:row;align-items:center;gap:6px;">
                <span>Tile Bg</span>
                <select id="st-tile-bg" style="min-height:32px;width:auto;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
                  <option value="blur">Blurred</option>
                  <option value="solid">Solid</option>
                  <option value="transparent">Transparent</option>
                </select>
                <input type="color" id="st-tile-bg-color" value="#090d16" title="Solid tile background color" style="width:32px;height:30px;padding:1px;" hidden>
              </label>
              <button type="button" class="btn btn-secondary btn-sm" id="st-labels-btn">Labels: On</button>
              <button type="button" class="btn btn-secondary btn-sm" id="st-audio-btn">Audio: Off</button>
            ` : ''}
            <button type="button" class="btn btn-warning btn-sm" id="st-clear-btn">Clear Wall (C)</button>
            <button type="button" class="btn btn-danger btn-sm" id="st-blackout-btn">Blackout (B)</button>
          </div>
        </section>

        <!-- Participants -->
        <section class="panel studio-participants-panel">
          <div class="panel-head" style="flex-wrap:wrap;">
            <h2 class="panel-title">Participants</h2>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
              <input type="search" id="st-search" placeholder="Search name..." style="max-width:180px;min-height:32px;padding:4px 10px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
              <div class="seg-tabs" id="st-filter-tabs">
                <button type="button" class="seg-tab active" data-filter="all">All</button>
                <button type="button" class="seg-tab" data-filter="waiting">Waiting</button>
                <button type="button" class="seg-tab" data-filter="onair">On Air</button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" id="st-bans-btn">Bans (<span id="st-ban-count">0</span>)</button>
            </div>
          </div>
          <div class="participants-grid" id="st-participants-grid"></div>
        </section>
      </div>

      <div class="studio-col">
        <!-- Live Wall Preview -->
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Wall Output Preview</h2>
            <span class="page-meta" id="st-obs-status">Checking OBS...</span>
          </div>
          <div class="wall-frame-wrap" id="st-wall-wrap">
            <iframe id="st-wall-iframe" src="${esc(buildMonitorWallSrc(initial.event, 'studio'))}"></iframe>
          </div>
        </section>

        <!-- QR Branding & Event Settings (Tabbed to fit viewport) -->
        <section class="panel studio-tools-panel">
          <div class="panel-head" style="flex-wrap:wrap;">
            <div class="seg-tabs" id="st-tools-tabs">
              <button type="button" class="seg-tab active" data-tool="qr">QR Branding</button>
              ${canHost ? '<button type="button" class="seg-tab" data-tool="settings">Event Settings</button>' : ''}
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <div style="display:flex;gap:6px;" id="st-qr-dl-actions">
                <button type="button" class="btn btn-secondary btn-sm" id="qr-dl-png">PNG</button>
                <button type="button" class="btn btn-secondary btn-sm" id="qr-dl-svg">SVG</button>
              </div>
              ${canHost && isSuper ? '<button type="button" class="btn btn-danger btn-sm" id="ev-delete-btn" hidden>Delete Event</button>' : ''}
            </div>
          </div>
          <div class="studio-tools-body">
            <div id="st-tab-qr">
              <div class="qr-studio-grid">
                <div class="qr-preview-box">
                  <canvas id="qr-studio-canvas" width="512" height="512"></canvas>
                  <button type="button" class="btn btn-secondary btn-sm" id="qr-test-scan-btn" style="width:100%;">Test Scan</button>
                  <div id="qr-test-result" style="font-size:12px;text-align:center;"></div>
                </div>
                <div style="display:flex;flex-direction:column;gap:8px;min-width:0;">
                  <div id="qr-safety-warn" class="adm-alert adm-alert-warn" hidden></div>
                  ${canHost ? `
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                      <button type="button" class="btn btn-primary btn-sm" id="qr-pick-logo-btn">Image Bank</button>
                      <button type="button" class="btn btn-ghost btn-sm" id="qr-remove-logo-btn">Remove Logo</button>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                      <label class="field">
                        <span>Logo Shape</span>
                        <select id="qr-shape">
                          <option value="square">Square</option>
                          <option value="circle">Circle</option>
                        </select>
                      </label>
                      <label class="field">
                        <span>Logo Fit</span>
                        <select id="qr-fit">
                          <option value="contain">Contain</option>
                          <option value="cover">Cover</option>
                        </select>
                      </label>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                      <label class="field">
                        <span>Size: <strong id="qr-scale-val">18%</strong></span>
                        <input type="range" id="qr-scale" min="10" max="22" value="18">
                      </label>
                      <label class="field">
                        <span>Pad: <strong id="qr-pad-val">8px</strong></span>
                        <input type="range" id="qr-pad" min="0" max="24" value="8">
                      </label>
                    </div>
                    <div class="qr-colors-grid">
                      <label class="field">
                        <span>QR Modules</span>
                        <input type="color" id="qr-fg" value="#000000">
                      </label>
                      <label class="field">
                        <span>QR Bg</span>
                        <input type="color" id="qr-bg" value="#ffffff">
                      </label>
                      <label class="field">
                        <span>Logo Bg</span>
                        <div style="display:flex;align-items:center;gap:6px;">
                          <input type="color" id="qr-logo-bg" value="#ffffff">
                          <label style="font-size:11px;white-space:nowrap;"><input type="checkbox" id="qr-logo-trans"> Clear</label>
                        </div>
                      </label>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm" id="qr-save-btn">Save QR Style</button>
                  ` : '<div class="page-meta">Only Hosts or Super Admins can edit QR branding.</div>'}
                </div>
              </div>
            </div>
            ${canHost ? `
            <div id="st-tab-settings" hidden>
              <form id="ev-settings-form" style="display:flex;flex-direction:column;gap:10px;">
                <div style="padding:10px;border-radius:8px;background:#0d1422;border:1px solid var(--border-hairline);display:flex;flex-direction:column;gap:8px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <span style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;">Audience Join Page Branding / Logo</span>
                    <span class="page-meta" id="ev-join-brand-status"></span>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <div id="ev-join-brand-preview" style="width:72px;height:72px;border-radius:8px;background:#070b14;border:1px solid var(--border-strong);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;"></div>
                    <div style="display:flex;flex-wrap:wrap;gap:6px;">
                      <input type="file" id="ev-join-brand-file" accept=".png,.jpg,.jpeg,.webp,.svg,image/*" hidden>
                      <button type="button" class="btn btn-primary btn-sm" id="ev-join-brand-upload">Upload Photo</button>
                      <button type="button" class="btn btn-secondary btn-sm" id="ev-join-brand-bank">Image Bank</button>
                      <button type="button" class="btn btn-ghost btn-sm" id="ev-join-brand-clear">Clear</button>
                    </div>
                  </div>
                </div>
                <label class="field">
                  <span>Event Title</span>
                  <input type="text" id="ev-set-title" maxlength="120" required>
                </label>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                  <label class="field">
                    <span>Status</span>
                    <select id="ev-set-status">
                      <option value="active">Active</option>
                      <option value="closed">Closed</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Max Participants</span>
                    <input type="number" id="ev-set-max" min="2" max="500">
                  </label>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                  <label class="field">
                    <span>Wall Fit Mode</span>
                    <select id="ev-set-fit">
                      <option value="fit">Fit (no crop, default)</option>
                      <option value="fill">Fill (crops the picture)</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Tile Background</span>
                    <div style="display:flex;gap:6px;align-items:center;">
                      <select id="ev-set-tilebg" style="flex:1;min-width:0;">
                        <option value="blur">Blurred video fill</option>
                        <option value="solid">Solid color</option>
                        <option value="transparent">Transparent</option>
                      </select>
                      <input type="color" id="ev-set-tilebg-color" value="#090d16" title="Solid tile background" hidden>
                    </div>
                  </label>
                </div>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
                  <input type="checkbox" id="ev-set-mirror"> Mirror front cameras on the wall
                </label>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
                  <input type="checkbox" id="ev-set-lock"> Lock new joins (existing guests stay connected)
                </label>
                <details class="adv-details" id="ev-set-adv">
                  <summary>Advanced display options</summary>
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
                    <input type="checkbox" id="ev-set-stretch"> Stretch video to fill tile (distorts aspect ratio)
                  </label>
                </details>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
                  <button type="submit" class="btn btn-primary btn-sm">Save Settings</button>
                  <button type="button" class="btn btn-secondary btn-sm" id="ev-edit-tos-btn">Terms of Service</button>
                  <button type="button" class="btn btn-secondary btn-sm" id="ev-regen-key-btn">Regenerate Wall Key</button>
                </div>
              </form>
            </div>
            ` : ''}
          </div>
        </section>
      </div>
    </div>
  `;

  // Scale embedded 1920x1080 iframe cleanly
  const wallWrap = document.getElementById('st-wall-wrap');
  const wallIframe = document.getElementById('st-wall-iframe');
  const syncWallScale = () => {
    if (!wallWrap.isConnected) {
      ro.disconnect();
      return;
    }
    const scale = wallWrap.clientWidth / 1920;
    if (scale > 0) wallIframe.style.transform = `scale(${scale})`;
  };
  const ro = new ResizeObserver(syncWallScale);
  ro.observe(wallWrap);
  requestAnimationFrame(syncWallScale);

  // Switch between QR Branding and Event Settings tabs
  const toolsTabsEl = document.getElementById('st-tools-tabs');
  toolsTabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (!btn) return;
    const tool = btn.dataset.tool;
    toolsTabsEl.querySelectorAll('.seg-tab').forEach((b) => b.classList.toggle('active', b === btn));
    const qrTab = document.getElementById('st-tab-qr');
    const setTab = document.getElementById('st-tab-settings');
    const dlActions = document.getElementById('st-qr-dl-actions');
    const delBtn = document.getElementById('ev-delete-btn');
    if (qrTab) qrTab.hidden = tool !== 'qr';
    if (setTab) setTab.hidden = tool !== 'settings';
    if (dlActions) dlActions.hidden = tool !== 'qr';
    if (delBtn) delBtn.hidden = tool !== 'settings';
    if (tool === 'qr') refreshQrPreview(true);
  });

  // Wire Copy buttons
  document.getElementById('copy-join-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastStateData.joinUrl);
    toast('Join URL copied');
  });
  document.getElementById('copy-wall-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastStateData.wallUrl);
    toast('OBS Wall URL copied');
  });

  // Wire Wall Action helper
  async function sendWallAction(payload) {
    try {
      const res = await api(`/api/admin/events/${eventId}/wall-action`, { method: 'POST', json: payload });
      if (res.summary) toast(res.summary);
      pokeWallIframe(wallIframe);
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  // Host controls
  if (canHost) {
    document.getElementById('st-layout').addEventListener('change', (e) => {
      sendWallAction({ action: 'set_layout', layout: e.target.value });
    });
    document.getElementById('st-max-feeds').addEventListener('change', async (e) => {
      try {
        await api(`/api/admin/events/${eventId}/settings`, {
          method: 'POST',
          json: { max_wall_feeds: Number(e.target.value) },
        });
        toast(`Max simultaneous feeds set to ${e.target.value}`);
        await refreshState();
      } catch (err) { toast(err.message); }
    });
    document.getElementById('st-fit-mode').addEventListener('change', async (e) => {
      try {
        await api(`/api/admin/events/${eventId}/settings`, {
          method: 'POST',
          json: { wall_fit_mode: e.target.value },
        });
        pokeWallIframe(wallIframe);
        toast(`Wall fit mode: ${e.target.value}`);
        await refreshState();
      } catch (err) { toast(err.message); }
    });
    document.getElementById('st-tile-bg').addEventListener('change', async (e) => {
      const bg = e.target.value;
      document.getElementById('st-tile-bg-color').hidden = bg !== 'solid';
      try {
        await api(`/api/admin/events/${eventId}/settings`, {
          method: 'POST',
          json: { wall_tile_bg: bg },
        });
        pokeWallIframe(wallIframe);
        toast(`Tile background: ${bg}`);
        await refreshState();
      } catch (err) { toast(err.message); }
    });
    document.getElementById('st-tile-bg-color').addEventListener('change', async (e) => {
      try {
        await api(`/api/admin/events/${eventId}/settings`, {
          method: 'POST',
          json: { wall_tile_bg: 'solid', wall_tile_bg_color: e.target.value },
        });
        pokeWallIframe(wallIframe);
        await refreshState();
      } catch (err) { toast(err.message); }
    });
    document.getElementById('st-labels-btn').addEventListener('click', () => {
      sendWallAction({ action: 'toggle_labels', show_labels: Number(lastStateData.event.show_labels) !== 1 });
    });
    document.getElementById('st-audio-btn').addEventListener('click', () => {
      sendWallAction({ action: 'toggle_audio', audio_enabled: Number(lastStateData.event.audio_enabled) !== 1 });
    });
  }

  document.getElementById('st-clear-btn').addEventListener('click', () => sendWallAction({ action: 'clear_wall' }));
  document.getElementById('st-blackout-btn').addEventListener('click', () => {
    sendWallAction({ action: 'blackout', blackout: Number(lastStateData.event.blackout) !== 1 });
  });

  // Search & Filters
  document.getElementById('st-search').addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderParticipants(lastStateData);
  });
  document.getElementById('st-filter-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    filterMode = btn.dataset.filter;
    document.querySelectorAll('#st-filter-tabs .seg-tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderParticipants(lastStateData);
  });

  // Bans modal
  document.getElementById('st-bans-btn').addEventListener('click', () => {
    const bans = lastStateData.bans || [];
    openModal(`
      <div class="panel-head"><h2 style="margin:0;">Banned Users (${bans.length})</h2><button type="button" class="btn btn-ghost btn-sm" id="bm-close">Close</button></div>
      ${bans.length === 0 ? '<p style="color:var(--text-secondary);">No banned participants for this event.</p>' : `
        <div class="data-table-wrap"><table class="data-table">
          <thead><tr><th>Name</th><th>Reason</th><th>Date</th><th></th></tr></thead>
          <tbody>${bans.map((b) => `
            <tr>
              <td>${esc(b.display_name)}</td>
              <td>${esc(b.reason)}</td>
              <td class="tabular">${esc(b.created_at)}</td>
              <td><button type="button" class="btn btn-secondary btn-sm unban-btn" data-ban-id="${b.id}">Unban</button></td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    `);
    document.getElementById('bm-close').addEventListener('click', closeModal);
    modalEl.querySelectorAll('.unban-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/admin/events/${eventId}/participant-action`, {
          method: 'POST',
          json: { action: 'unban', ban_id: Number(btn.dataset.banId) },
        });
        toast('Ban removed');
        closeModal();
        refreshState();
      });
    });
  });

  // QR Studio rendering & controls
  const qrCanvas = document.getElementById('qr-studio-canvas');
  const qrWarnEl = document.getElementById('qr-safety-warn');
  const qrTestResultEl = document.getElementById('qr-test-result');

  async function refreshQrPreview(force = false) {
    const opts = {
      text: lastStateData.joinUrl,
      logoUrl: qrDraft.logo_filename ? `/uploads/logos/${encodeURIComponent(qrDraft.logo_filename)}` : null,
      shape: qrDraft.qr_logo_shape,
      fit: qrDraft.qr_logo_fit,
      scalePct: qrDraft.qr_logo_scale,
      paddingPx: qrDraft.qr_logo_padding,
      logoBg: qrDraft.qr_logo_bg,
      fg: qrDraft.qr_fg,
      bg: qrDraft.qr_bg,
      size: 512,
    };
    const sig = JSON.stringify(opts);
    if (!force && sig === lastQrRenderSig) return;
    lastQrRenderSig = sig;

    const safety = checkQrSafety({
      hasLogo: !!opts.logoUrl,
      scalePct: opts.scalePct,
      paddingPx: opts.paddingPx,
      fg: opts.fg,
      bg: opts.bg,
    });
    if (safety.warnings.length > 0) {
      qrWarnEl.textContent = safety.warnings.join(' ');
      qrWarnEl.hidden = false;
    } else {
      qrWarnEl.hidden = true;
    }

    await renderBrandedQR(qrCanvas, opts);
    qrTestResultEl.textContent = '';
  }

  document.getElementById('qr-test-scan-btn').addEventListener('click', () => {
    const res = testScanCanvas(qrCanvas, lastStateData.joinUrl);
    qrTestResultEl.className = res.scannable ? 'status-text-green' : 'status-text-red';
    qrTestResultEl.textContent = res.scannable ? 'Scannable (ECC H verified)' : `Not scannable — ${res.reason}`;
  });

  document.getElementById('qr-dl-png').addEventListener('click', async () => {
    const c = document.createElement('canvas');
    await renderBrandedQR(c, {
      text: lastStateData.joinUrl,
      logoUrl: qrDraft.logo_filename ? `/uploads/logos/${encodeURIComponent(qrDraft.logo_filename)}` : null,
      shape: qrDraft.qr_logo_shape,
      fit: qrDraft.qr_logo_fit,
      scalePct: qrDraft.qr_logo_scale,
      paddingPx: qrDraft.qr_logo_padding,
      logoBg: qrDraft.qr_logo_bg,
      fg: qrDraft.qr_fg,
      bg: qrDraft.qr_bg,
      size: 1024,
    });
    c.toBlob((blob) => { if (blob) downloadBlob(blob, `${lastStateData.event.slug}-qr.png`); }, 'image/png');
  });

  document.getElementById('qr-dl-svg').addEventListener('click', async () => {
    const svg = await renderBrandedQRSvg({
      text: lastStateData.joinUrl,
      logoUrl: qrDraft.logo_filename ? `/uploads/logos/${encodeURIComponent(qrDraft.logo_filename)}` : null,
      shape: qrDraft.qr_logo_shape,
      fit: qrDraft.qr_logo_fit,
      scalePct: qrDraft.qr_logo_scale,
      paddingPx: qrDraft.qr_logo_padding,
      logoBg: qrDraft.qr_logo_bg,
      fg: qrDraft.qr_fg,
      bg: qrDraft.qr_bg,
      size: 1024,
    });
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${lastStateData.event.slug}-qr.svg`);
  });

  if (canHost) {
    const shapeEl = document.getElementById('qr-shape');
    const fitEl = document.getElementById('qr-fit');
    const scaleEl = document.getElementById('qr-scale');
    const padEl = document.getElementById('qr-pad');
    const fgEl = document.getElementById('qr-fg');
    const bgEl = document.getElementById('qr-bg');
    const logoBgEl = document.getElementById('qr-logo-bg');
    const logoTransEl = document.getElementById('qr-logo-trans');

    shapeEl.value = qrDraft.qr_logo_shape;
    fitEl.value = qrDraft.qr_logo_fit;
    scaleEl.value = String(qrDraft.qr_logo_scale);
    document.getElementById('qr-scale-val').textContent = `${qrDraft.qr_logo_scale}%`;
    padEl.value = String(qrDraft.qr_logo_padding);
    document.getElementById('qr-pad-val').textContent = `${qrDraft.qr_logo_padding}px`;
    fgEl.value = qrDraft.qr_fg;
    bgEl.value = qrDraft.qr_bg;
    logoTransEl.checked = qrDraft.qr_logo_bg === 'transparent';
    logoBgEl.value = qrDraft.qr_logo_bg === 'transparent' ? '#ffffff' : qrDraft.qr_logo_bg;

    const syncDraftFromInputs = () => {
      qrDraft.qr_logo_shape = shapeEl.value;
      qrDraft.qr_logo_fit = fitEl.value;
      qrDraft.qr_logo_scale = Number(scaleEl.value);
      qrDraft.qr_logo_padding = Number(padEl.value);
      qrDraft.qr_fg = fgEl.value;
      qrDraft.qr_bg = bgEl.value;
      qrDraft.qr_logo_bg = logoTransEl.checked ? 'transparent' : logoBgEl.value;
      document.getElementById('qr-scale-val').textContent = `${qrDraft.qr_logo_scale}%`;
      document.getElementById('qr-pad-val').textContent = `${qrDraft.qr_logo_padding}px`;
      refreshQrPreview();
    };
    [shapeEl, fitEl, scaleEl, padEl, fgEl, bgEl, logoBgEl, logoTransEl].forEach((el) => el.addEventListener('input', syncDraftFromInputs));

    document.getElementById('qr-remove-logo-btn').addEventListener('click', () => {
      qrDraft.logo_image_id = null;
      qrDraft.logo_filename = null;
      refreshQrPreview();
    });

    document.getElementById('qr-pick-logo-btn').addEventListener('click', () => openLogoPickerModal((img) => {
      qrDraft.logo_image_id = Number(img.id);
      qrDraft.logo_filename = img.filename;
      refreshQrPreview();
    }));

    document.getElementById('qr-save-btn').addEventListener('click', async () => {
      try {
        await api(`/api/admin/events/${eventId}/settings`, {
          method: 'POST',
          json: {
            logo_image_id: qrDraft.logo_image_id,
            qr_logo_shape: qrDraft.qr_logo_shape,
            qr_logo_fit: qrDraft.qr_logo_fit,
            qr_logo_scale: qrDraft.qr_logo_scale,
            qr_logo_padding: qrDraft.qr_logo_padding,
            qr_logo_bg: qrDraft.qr_logo_bg,
            qr_fg: qrDraft.qr_fg,
            qr_bg: qrDraft.qr_bg,
          },
        });
        toast('QR branding saved');
        await refreshState();
      } catch (err) {
        toast(err.message);
      }
    });

    // Audience Join Page Branding / Logo controls
    const syncJoinBrandPreview = (ev) => {
      const prevEl = document.getElementById('ev-join-brand-preview');
      const statusEl = document.getElementById('ev-join-brand-status');
      if (!prevEl || !statusEl) return;
      const customFile = ev.join_logo_filename || null;
      const qrFile = ev.logo_filename || null;
      const shownFile = customFile || qrFile;
      if (shownFile) {
        prevEl.innerHTML = `<img src="/uploads/logos/${encodeURIComponent(shownFile)}" alt="Audience join branding" style="width:100%;height:100%;object-fit:contain;">`;
        statusEl.textContent = customFile ? 'Custom join photo' : 'Using QR logo';
      } else {
        prevEl.innerHTML = '<span class="page-meta" style="font-size:11px;">None</span>';
        statusEl.textContent = 'No photo set';
      }
    };
    syncJoinBrandPreview(initial.event);

    const saveJoinBrandImage = async (imageId) => {
      await api(`/api/admin/events/${eventId}/settings`, {
        method: 'POST',
        json: { join_logo_image_id: imageId },
      });
      toast(imageId ? 'Audience join branding saved' : 'Custom join branding cleared');
      await refreshState();
      if (lastStateData?.event) syncJoinBrandPreview(lastStateData.event);
    };

    const joinBrandFileEl = document.getElementById('ev-join-brand-file');
    document.getElementById('ev-join-brand-upload').addEventListener('click', () => joinBrandFileEl.click());
    joinBrandFileEl.addEventListener('change', async () => {
      if (!joinBrandFileEl.files?.length) return;
      try {
        const res = await uploadImageFiles(joinBrandFileEl.files, 'shared', 'join-branding');
        const first = res.uploaded?.[0]?.image;
        if (first) {
          await saveJoinBrandImage(Number(first.id));
        }
      } catch (err) {
        toast(err.message);
      } finally {
        joinBrandFileEl.value = '';
      }
    });
    document.getElementById('ev-join-brand-bank').addEventListener('click', () => {
      openLogoPickerModal(async (img) => {
        try {
          await saveJoinBrandImage(Number(img.id));
        } catch (err) {
          toast(err.message);
        }
      }, 'Select Audience Join Branding Photo');
    });
    document.getElementById('ev-join-brand-clear').addEventListener('click', async () => {
      try {
        await saveJoinBrandImage(null);
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('ev-edit-tos-btn')?.addEventListener('click', openTermsOfServiceModal);

    // Event Settings form
    const initFit = initial.event.wall_fit_mode || 'fit';
    const initBg = initial.event.wall_tile_bg || 'blur';
    const initBgCol = initial.event.wall_tile_bg_color || '#090d16';
    document.getElementById('ev-set-title').value = initial.event.title;
    document.getElementById('ev-set-status').value = initial.event.status;
    document.getElementById('ev-set-max').value = initial.event.max_participants;
    document.getElementById('ev-set-lock').checked = Number(initial.event.join_locked) === 1;
    document.getElementById('ev-set-fit').value = initFit === 'fill' ? 'fill' : 'fit';
    document.getElementById('ev-set-stretch').checked = initFit === 'stretch';
    document.getElementById('ev-set-tilebg').value = initBg;
    document.getElementById('ev-set-tilebg-color').value = initBgCol;
    document.getElementById('ev-set-tilebg-color').hidden = initBg !== 'solid';
    document.getElementById('ev-set-mirror').checked = Number(initial.event.mirror_front_wall || 0) === 1;

    document.getElementById('ev-set-tilebg').addEventListener('change', (e) => {
      document.getElementById('ev-set-tilebg-color').hidden = e.target.value !== 'solid';
    });

    document.getElementById('ev-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const chosenFit = document.getElementById('ev-set-stretch').checked
        ? 'stretch'
        : document.getElementById('ev-set-fit').value;
      try {
        await api(`/api/admin/events/${eventId}/settings`, {
          method: 'POST',
          json: {
            title: document.getElementById('ev-set-title').value,
            status: document.getElementById('ev-set-status').value,
            max_participants: Number(document.getElementById('ev-set-max').value),
            join_locked: document.getElementById('ev-set-lock').checked,
            wall_fit_mode: chosenFit,
            wall_tile_bg: document.getElementById('ev-set-tilebg').value,
            wall_tile_bg_color: document.getElementById('ev-set-tilebg-color').value,
            mirror_front_wall: document.getElementById('ev-set-mirror').checked,
          },
        });
        pokeWallIframe(wallIframe);
        toast('Event settings updated');
        await refreshState();
      } catch (err) {
        toast(err.message);
      }
    });

    document.getElementById('ev-regen-key-btn').addEventListener('click', async () => {
      const res = await api(`/api/admin/events/${eventId}/settings`, {
        method: 'POST',
        json: { regen_wall_key: true },
      });
      toast('Wall key regenerated — update your OBS Browser Source URL');
      await refreshState();
      wallIframe.src = buildMonitorWallSrc(lastStateData.event, 'studio');
    });

    if (isSuper) {
      document.getElementById('ev-delete-btn').addEventListener('click', async () => {
        openModal(`
          <h2 style="margin:0;">Delete Event?</h2>
          <p style="color:var(--text-secondary);">This permanently deletes <strong>${esc(lastStateData.event.title)}</strong> and all participant records.</p>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="btn btn-ghost" id="del-cancel">Cancel</button>
            <button type="button" class="btn btn-danger" id="del-confirm">Delete Event</button>
          </div>
        `);
        document.getElementById('del-cancel').addEventListener('click', closeModal);
        document.getElementById('del-confirm').addEventListener('click', async () => {
          await api(`/api/admin/events/${eventId}`, { method: 'DELETE' });
          closeModal();
          toast('Event deleted');
          navigate('/admin/events');
        });
      });
    }
  }

  // Keyboard shortcuts (1-4 slot selection, C clear wall, B blackout)
  const keyHandler = (ev) => {
    if (activeEventId !== eventId || !modalBackdrop.hidden) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    if (['1', '2', '3', '4'].includes(ev.key)) {
      selectedSlot = Number(ev.key);
      toast(`Selected Slot ${selectedSlot}`);
      renderSlots(lastStateData);
    } else if (ev.key.toLowerCase() === 'c') {
      sendWallAction({ action: 'clear_wall' });
    } else if (ev.key.toLowerCase() === 'b') {
      sendWallAction({ action: 'blackout', blackout: Number(lastStateData.event.blackout) !== 1 });
    }
  };
  document.addEventListener('keydown', keyHandler);

  function renderSlots(data) {
    const ev = data.event;
    const maxFeeds = Number(ev.max_wall_feeds);
    const bySlot = new Map();
    for (const p of data.participants) {
      if (p.slot_no) bySlot.set(p.slot_no, p);
    }
    const grid = document.getElementById('st-slots-grid');
    grid.innerHTML = [1, 2, 3, 4].map((n) => {
      const occ = bySlot.get(n);
      const disabled = n > maxFeeds;
      const sel = selectedSlot === n ? 'outline:2px solid #60a5fa;' : '';
      const slotFit = occ?.slot_fit_mode || '';
      return `
        <div class="slot-box ${occ ? 'occupied' : ''} ${disabled ? 'disabled' : ''}" data-slot="${n}" draggable="${occ ? 'true' : 'false'}" style="${sel}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="slot-num">SLOT ${n}</span>
            ${occ ? `<button type="button" class="btn btn-ghost btn-sm slot-remove-btn" data-pid="${occ.id}" style="min-height:24px;padding:2px 6px;font-size:11px;">&times;</button>` : ''}
          </div>
          <div class="slot-occ-name">${occ ? esc(occ.display_name) : (disabled ? 'Disabled' : 'Empty (QR / Idle)')}</div>
          ${occ && canHost ? `
            <select class="slot-fit-select" data-slot="${n}" title="Per-tile fit override">
              <option value="inherit" ${!slotFit ? 'selected' : ''}>Fit: Event (${esc(ev.wall_fit_mode || 'fit')})</option>
              <option value="fit" ${slotFit === 'fit' ? 'selected' : ''}>Tile: Fit (no crop)</option>
              <option value="fill" ${slotFit === 'fill' ? 'selected' : ''}>Tile: Fill (crops)</option>
              <optgroup label="Advanced">
                <option value="stretch" ${slotFit === 'stretch' ? 'selected' : ''}>Tile: Stretch</option>
              </optgroup>
            </select>
          ` : ''}
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.slot-remove-btn').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        sendWallAction({ action: 'remove_from_wall', participant_id: Number(b.dataset.pid) });
      });
    });

    grid.querySelectorAll('.slot-fit-select').forEach((selEl) => {
      selEl.addEventListener('click', (e) => e.stopPropagation());
      selEl.addEventListener('change', (e) => {
        e.stopPropagation();
        sendWallAction({
          action: 'set_slot_fit',
          slot_no: Number(selEl.dataset.slot),
          fit_mode: selEl.value === 'inherit' ? null : selEl.value,
        });
      });
    });

    grid.querySelectorAll('.slot-box').forEach((box) => {
      const slotNo = Number(box.dataset.slot);
      box.addEventListener('click', () => {
        if (slotNo <= maxFeeds) {
          selectedSlot = selectedSlot === slotNo ? null : slotNo;
          renderSlots(lastStateData);
        }
      });
      box.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(slotNo));
      });
      box.addEventListener('dragover', (e) => {
        if (slotNo <= maxFeeds) {
          e.preventDefault();
          box.classList.add('drag-over');
        }
      });
      box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
      box.addEventListener('drop', (e) => {
        e.preventDefault();
        box.classList.remove('drag-over');
        const fromSlot = Number(e.dataTransfer.getData('text/plain'));
        if (fromSlot && fromSlot !== slotNo && slotNo <= maxFeeds) {
          sendWallAction({ action: 'swap_slots', from_slot: fromSlot, to_slot: slotNo });
        }
      });
    });
  }

  function renderParticipants(data) {
    const grid = document.getElementById('st-participants-grid');
    let list = data.participants || [];
    if (filterMode !== 'all') {
      list = list.filter((p) => p.status === filterMode);
    }
    if (searchQuery) {
      list = list.filter((p) => p.display_name.toLowerCase().includes(searchQuery) || (p.message || '').toLowerCase().includes(searchQuery));
    }

    if (list.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-secondary);">No participants matching current filter.</div>`;
      return;
    }

    grid.innerHTML = list.map((p) => {
      const isOnAir = p.status === 'onair';
      const thumbUrl = p.has_thumb ? `/api/admin/events/${eventId}/participants/${p.id}/thumb?v=${p.thumb_version}` : '';
      const capStr = formatCaptureSummary(p);
      return `
        <article class="part-card ${isOnAir ? 'is-onair' : ''}">
          <div class="part-thumb" data-preview-pid="${p.id}">
            ${thumbUrl ? `<img src="${thumbUrl}" alt="${esc(p.display_name)}">` : '<div class="part-thumb-empty">Waiting for camera...</div>'}
            ${isOnAir ? `<span class="part-onair-mark">ON AIR · S${p.slot_no}</span>` : ''}
          </div>
          <div class="part-body">
            <div class="part-name">${esc(p.display_name)}${p.name_hidden ? ' (Hidden)' : ''}${p.muted_by_admin ? ' · Muted' : ''}</div>
            <div class="part-msg">${esc(p.message || '')}</div>
            <div class="part-meta tabular">Joined ${esc(p.joined_at.slice(11, 19))} UTC${capStr !== '—' ? ` · ${esc(capStr)}` : ''}</div>
            <div class="part-actions">
              ${isOnAir
                ? `<button type="button" class="btn btn-secondary btn-sm p-remove" data-pid="${p.id}">Remove</button>`
                : `<button type="button" class="btn btn-primary btn-sm p-put" data-pid="${p.id}">${selectedSlot ? `Put Slot ${selectedSlot}` : 'Put on Wall'}</button>`
              }
              <button type="button" class="btn btn-ghost btn-sm p-mute" data-pid="${p.id}">${p.muted_by_admin ? 'Unmute' : 'Mute'}</button>
              <button type="button" class="btn btn-ghost btn-sm p-name" data-pid="${p.id}">Name</button>
              <button type="button" class="btn btn-ghost btn-sm p-kick" data-pid="${p.id}">Kick</button>
              <button type="button" class="btn btn-danger btn-sm p-ban" data-pid="${p.id}">Ban</button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    grid.querySelectorAll('.part-thumb').forEach((el) => {
      el.addEventListener('click', () => openParticipantPreviewModal(Number(el.dataset.previewPid)));
    });
    grid.querySelectorAll('.p-put').forEach((b) => {
      b.addEventListener('click', () => {
        const pid = Number(b.dataset.pid);
        sendWallAction({ action: 'put_on_wall', participant_id: pid, ...(selectedSlot ? { slot_no: selectedSlot } : {}) });
      });
    });
    grid.querySelectorAll('.p-remove').forEach((b) => {
      b.addEventListener('click', () => sendWallAction({ action: 'remove_from_wall', participant_id: Number(b.dataset.pid) }));
    });
    grid.querySelectorAll('.p-mute').forEach((b) => {
      b.addEventListener('click', async () => {
        await api(`/api/admin/events/${eventId}/participant-action`, { method: 'POST', json: { action: 'mute_toggle', participant_id: Number(b.dataset.pid) } });
        pokeWallIframe(wallIframe);
        refreshState();
      });
    });
    grid.querySelectorAll('.p-kick').forEach((b) => {
      b.addEventListener('click', async () => {
        await api(`/api/admin/events/${eventId}/participant-action`, { method: 'POST', json: { action: 'kick', participant_id: Number(b.dataset.pid) } });
        toast('Participant kicked');
        pokeWallIframe(wallIframe);
        refreshState();
      });
    });
    grid.querySelectorAll('.p-ban').forEach((b) => {
      b.addEventListener('click', async () => {
        await api(`/api/admin/events/${eventId}/participant-action`, { method: 'POST', json: { action: 'ban', participant_id: Number(b.dataset.pid), reason: 'Banned by moderator' } });
        toast('Participant banned');
        pokeWallIframe(wallIframe);
        refreshState();
      });
    });
    grid.querySelectorAll('.p-name').forEach((b) => {
      b.addEventListener('click', () => {
        const p = lastStateData.participants.find((x) => x.id === Number(b.dataset.pid));
        if (!p) return;
        openModal(`
          <h2 style="margin:0;">Edit Display Name</h2>
          <form id="edit-name-form" class="adm-auth-form">
            <label class="field"><span>Display Name</span><input type="text" id="en-name" value="${esc(p.display_name)}" maxlength="40" required></label>
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;">
              <input type="checkbox" id="en-hidden" ${p.name_hidden ? 'checked' : ''}> Hide name on wall (shows as "Guest")
            </label>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="button" class="btn btn-ghost" id="en-cancel">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        `);
        document.getElementById('en-cancel').addEventListener('click', closeModal);
        document.getElementById('edit-name-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await api(`/api/admin/events/${eventId}/participant-action`, {
            method: 'POST',
            json: {
              action: 'edit_name',
              participant_id: p.id,
              display_name: document.getElementById('en-name').value,
              name_hidden: document.getElementById('en-hidden').checked,
            },
          });
          closeModal();
          refreshState();
        });
      });
    });
  }

  function openParticipantPreviewModal(pid) {
    const p = lastStateData.participants.find((x) => x.id === pid);
    if (!p) return;
    const capStr = formatCaptureSummary(p);
    openModal(`
      <div class="panel-head"><h2 style="margin:0;">Preview: ${esc(p.display_name)}</h2><button type="button" class="btn btn-ghost btn-sm" id="pm-close">Close</button></div>
      <div id="pm-tile-wrap" style="background:#000;border-radius:8px;overflow:hidden;aspect-ratio:16/9;position:relative;"></div>
      <div class="page-meta tabular">${capStr !== '—' ? `Phone camera: ${esc(capStr)}` : 'Waiting for phone camera telemetry...'}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--text-secondary);">Audio Level</span>
          <div class="meter-bar"><div class="meter-fill" id="pm-meter"></div></div>
          <button type="button" class="btn btn-secondary btn-sm" id="pm-listen-btn">Listen: Muted</button>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn btn-success btn-sm" id="pm-take-btn">Take (Send to Wall)</button>
        </div>
      </div>
    `);
    const ev = lastStateData?.event || initial.event;
    const pmTile = createWallTile();
    pmTile.lowerEl.hidden = true;
    updateWallTileAppearance(pmTile, {
      fitMode: 'fit',
      tileBg: ev.wall_tile_bg || 'blur',
      tileBgColor: ev.wall_tile_bg_color || '#090d16',
      mirrored: false,
      captureInfo: p.capture_settings || null,
    });
    document.getElementById('pm-tile-wrap').appendChild(pmTile.root);
    const mEl = document.getElementById('pm-meter');
    startPrivatePreview(eventId, pid, { tile: pmTile, meterFillEl: mEl, unmuteAudio: false });

    document.getElementById('pm-listen-btn').addEventListener('click', (e) => {
      previewAudioEnabled = !previewAudioEnabled;
      pmTile.video.muted = !previewAudioEnabled;
      e.target.textContent = previewAudioEnabled ? 'Listen: Active' : 'Listen: Muted';
    });
    document.getElementById('pm-take-btn').addEventListener('click', async () => {
      await stopPreviewSession(false);
      closeModal();
      sendWallAction({ action: 'preview_take', participant_id: pid, ...(selectedSlot ? { slot_no: selectedSlot } : {}) });
    });
    document.getElementById('pm-close').addEventListener('click', async () => {
      await stopPreviewSession(true);
      closeModal();
    });
  }

  function applyStateToUI(data) {
    lastStateData = normalizeEventUrls(data);
    const ev = data.event;
    document.getElementById('st-title').textContent = ev.title;
    const adminsStr = (data.online_admins || []).map((a) => a.display_name).join(', ');
    document.getElementById('st-meta').textContent = `/${ev.slug} · ${ev.status.toUpperCase()} · ${data.counters.onair} on air · ${data.counters.waiting} waiting · Online here: ${adminsStr || cfg.user.display_name}`;
    document.getElementById('st-ban-count').textContent = String((data.bans || []).length);

    const newVer = Number(ev.state_version);
    if (lastStateVersion !== null && newVer !== lastStateVersion && ev.last_action_by && ev.last_action_by !== cfg.user.display_name) {
      const notice = document.getElementById('st-conflict-notice');
      notice.textContent = `Updated by ${ev.last_action_by}: ${ev.last_action_summary}`;
      notice.hidden = false;
    }
    lastStateVersion = newVer;

    if (canHost) {
      document.getElementById('st-layout').value = ev.layout;
      document.getElementById('st-max-feeds').value = String(ev.max_wall_feeds);
      document.getElementById('st-fit-mode').value = ev.wall_fit_mode || 'fit';
      const tileBg = ev.wall_tile_bg || 'blur';
      document.getElementById('st-tile-bg').value = tileBg;
      const colEl = document.getElementById('st-tile-bg-color');
      colEl.value = ev.wall_tile_bg_color || '#090d16';
      colEl.hidden = tileBg !== 'solid';
      document.getElementById('st-labels-btn').textContent = Number(ev.show_labels) === 1 ? 'Labels: On' : 'Labels: Off';
      document.getElementById('st-audio-btn').textContent = Number(ev.audio_enabled) === 1 ? 'Audio: On' : 'Audio: Off';
      const prevEl = document.getElementById('ev-join-brand-preview');
      const statusEl = document.getElementById('ev-join-brand-status');
      if (prevEl && statusEl) {
        const shownFile = ev.join_logo_filename || ev.logo_filename || null;
        prevEl.innerHTML = shownFile
          ? `<img src="/uploads/logos/${encodeURIComponent(shownFile)}" alt="Audience join branding" style="width:100%;height:100%;object-fit:contain;">`
          : '<span class="page-meta" style="font-size:11px;">None</span>';
        statusEl.textContent = ev.join_logo_filename ? 'Custom join photo' : (ev.logo_filename ? 'Using QR logo' : 'No photo set');
      }
    }
    const blkBtn = document.getElementById('st-blackout-btn');
    blkBtn.textContent = Number(ev.blackout) === 1 ? 'End Blackout (B)' : 'Blackout (B)';

    const obsEl = document.getElementById('st-obs-status');
    obsEl.className = data.wall_heartbeat.online ? 'status-text-green' : 'status-text-red';
    obsEl.textContent = data.wall_heartbeat.online
      ? `OBS Online (${data.wall_heartbeat.resolution || '1920x1080'})`
      : 'OBS Offline';

    renderSlots(data);
    renderParticipants(data);
  }

  async function refreshState() {
    if (activeEventId !== eventId) return;
    try {
      const data = await api(`/api/admin/events/${eventId}/state`);
      applyStateToUI(data);
    } catch {}
  }

  applyStateToUI(initial);
  await refreshQrPreview(true);

  const schedulePoll = () => {
    if (activeEventId !== eventId) return;
    pollTimer = setTimeout(async () => {
      await refreshState();
      schedulePoll();
    }, cfg.adminPollMs || 1500);
  };
  schedulePoll();
}

// ---------------- VIEW: LIVE MONITOR DASHBOARD ----------------

async function renderMonitorView(eventId) {
  activeEventId = eventId;
  mainEl.innerHTML = `<div class="adm-loading">Loading live monitor...</div>`;

  let initial;
  try {
    initial = normalizeEventUrls(await api(`/api/admin/events/${eventId}/state`));
  } catch (err) {
    mainEl.innerHTML = `<div class="adm-alert adm-alert-error">${esc(err.message)}</div>`;
    return;
  }

  lastStateData = initial;

  mainEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Monitor: ${esc(initial.event.title)}</h1>
        <div class="page-meta" id="mon-sub">Real-time program output, stream telemetry &amp; candidate preview</div>
      </div>
      <div class="page-actions">
        <a href="/admin/frame-check?event=${eventId}" data-nav="/admin/frame-check?event=${eventId}" class="btn btn-secondary btn-sm">Frame Check</a>
        <button type="button" class="btn btn-secondary btn-sm" id="mon-chime-btn">Alert Sound: Off</button>
        <a href="/admin/events/${eventId}" data-nav="/admin/events/${eventId}" class="btn btn-primary btn-sm">Control Studio</a>
      </div>
    </div>

    <div class="counters-strip">
      <div class="kpi-box"><div class="kpi-label">Total Joined</div><div class="kpi-val tabular" id="kpi-joined">0</div></div>
      <div class="kpi-box"><div class="kpi-label">Waiting</div><div class="kpi-val tabular" id="kpi-waiting">0</div></div>
      <div class="kpi-box"><div class="kpi-label">On Air</div><div class="kpi-val tabular" id="kpi-onair">0</div></div>
      <div class="kpi-box"><div class="kpi-label">Kicked / Banned</div><div class="kpi-val tabular" id="kpi-kicked">0</div></div>
      <div class="kpi-box"><div class="kpi-label">Peak Concurrent</div><div class="kpi-val tabular" id="kpi-peak">0</div></div>
      <div class="kpi-box"><div class="kpi-label">Event Duration</div><div class="kpi-val tabular" id="kpi-dur">00:00:00</div></div>
    </div>

    <div class="monitor-top-grid">
      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Program / Wall Output</h2>
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="mon-pgm-badge" style="font-size:13px;font-weight:800;">IDLE (QR SHOWING)</span>
            <button type="button" class="btn btn-ghost btn-sm" id="mon-refresh-wall-btn" title="Reload program output preview">Refresh</button>
          </div>
        </div>
        <div class="wall-frame-wrap" id="mon-wall-wrap">
          <iframe id="mon-wall-iframe" src="${esc(buildMonitorWallSrc(initial.event, 'mon'))}"></iframe>
        </div>
      </section>

      <div style="display:flex;flex-direction:column;gap:12px;min-width:0;">
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">OBS Browser Source Heartbeat</h2>
            <span id="mon-hb-state" style="font-size:13px;">Checking...</span>
          </div>
          <div id="mon-hb-details" class="page-meta tabular"></div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Alerts</h2></div>
          <div id="mon-alerts" style="display:flex;flex-direction:column;gap:8px;"></div>
        </section>

        <section class="panel" id="mon-preview-panel">
          <div class="panel-head">
            <h2 class="panel-title">Private Candidate Preview</h2>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn btn-success btn-sm" id="mon-take-btn" disabled>Take to Wall</button>
              <button type="button" class="btn btn-ghost btn-sm" id="mon-stop-prev-btn" disabled>Stop</button>
            </div>
          </div>
          <div id="mon-preview-wrap" style="background:#05070c;border-radius:6px;overflow:hidden;aspect-ratio:16/9;position:relative;"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:8px;">
            <span class="page-meta" id="mon-preview-label">Select any waiting guest below to private-preview</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="meter-bar"><div class="meter-fill" id="mon-preview-meter"></div></div>
              <button type="button" class="btn btn-secondary btn-sm" id="mon-preview-listen-btn" disabled>Listen: Off</button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <section class="panel" style="margin-bottom:14px;">
      <div class="panel-head">
        <h2 class="panel-title">On-Air Feed Health &amp; Camera Telemetry</h2>
        <span class="page-meta">Live WebRTC getStats() + phone track.getSettings()</span>
      </div>
      <div id="mon-health-list"></div>
    </section>

    <div class="monitor-top-grid">
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Waiting Lobby Candidates</h2></div>
        <div class="participants-grid" id="mon-candidates"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Activity Timeline</h2></div>
        <div class="timeline-list" id="mon-timeline"></div>
      </section>
    </div>
  `;

  const wallWrap = document.getElementById('mon-wall-wrap');
  const wallIframe = document.getElementById('mon-wall-iframe');
  let monitorWallKey = String(initial.event.wall_key || '');
  let lastMonOnairCount = Number(initial.counters.onair || 0);
  const syncMonScale = () => {
    if (!wallWrap.isConnected) {
      monRo.disconnect();
      return;
    }
    const scale = wallWrap.clientWidth / 1920;
    if (scale > 0) wallIframe.style.transform = `scale(${scale})`;
  };
  const monRo = new ResizeObserver(syncMonScale);
  monRo.observe(wallWrap);
  requestAnimationFrame(syncMonScale);

  document.getElementById('mon-refresh-wall-btn').addEventListener('click', () => {
    const ev = lastStateData?.event || initial.event;
    wallIframe.src = buildMonitorWallSrc(ev, 'mon');
    toast('Program output refreshed');
  });

  document.getElementById('mon-chime-btn').addEventListener('click', (e) => {
    soundAlertsEnabled = !soundAlertsEnabled;
    e.target.textContent = soundAlertsEnabled ? 'Alert Sound: On' : 'Alert Sound: Off';
  });

  const pvTile = createWallTile();
  pvTile.lowerEl.hidden = true;
  pvTile.connEl.textContent = 'No preview active';
  updateWallTileAppearance(pvTile, {
    fitMode: 'fit',
    tileBg: initial.event.wall_tile_bg || 'blur',
    tileBgColor: initial.event.wall_tile_bg_color || '#090d16',
    mirrored: false,
  });
  document.getElementById('mon-preview-wrap').appendChild(pvTile.root);

  const pvVideo = pvTile.video;
  const pvMeter = document.getElementById('mon-preview-meter');
  const pvLabel = document.getElementById('mon-preview-label');
  const pvListenBtn = document.getElementById('mon-preview-listen-btn');
  const pvTakeBtn = document.getElementById('mon-take-btn');
  const pvStopBtn = document.getElementById('mon-stop-prev-btn');
  let activePreviewPid = null;

  pvListenBtn.addEventListener('click', () => {
    previewAudioEnabled = !previewAudioEnabled;
    pvVideo.muted = !previewAudioEnabled;
    pvListenBtn.textContent = previewAudioEnabled ? 'Listen: On' : 'Listen: Off';
  });

  pvTakeBtn.addEventListener('click', async () => {
    if (!activePreviewPid) return;
    const pid = activePreviewPid;
    await stopPreviewSession(false);
    activePreviewPid = null;
    pvTakeBtn.disabled = true;
    pvStopBtn.disabled = true;
    pvListenBtn.disabled = true;
    pvLabel.textContent = 'Sent to wall';
    await api(`/api/admin/events/${eventId}/wall-action`, { method: 'POST', json: { action: 'preview_take', participant_id: pid } });
    pokeWallIframe(wallIframe);
    toast('Candidate taken live to wall');
    await refreshMon();
  });

  pvStopBtn.addEventListener('click', async () => {
    await stopPreviewSession(true);
    activePreviewPid = null;
    attachStreamToWallTile(pvTile, null);
    pvTile.connEl.hidden = false;
    pvTile.connEl.textContent = 'Preview stopped';
    pvTakeBtn.disabled = true;
    pvStopBtn.disabled = true;
    pvListenBtn.disabled = true;
    pvLabel.textContent = 'Preview stopped';
  });

  function healthBadge(wStats) {
    if (!wStats) return { cls: 'status-text-amber', label: 'Connecting...' };
    if (['failed', 'disconnected', 'closed'].includes(wStats.state)) return { cls: 'status-text-red', label: wStats.state.toUpperCase() };
    if (wStats.packet_loss > 5 || wStats.rtt > 350) return { cls: 'status-text-amber', label: 'DEGRADED' };
    if (wStats.state === 'connected' || wStats.state === 'completed') return { cls: 'status-text-green', label: 'HEALTHY' };
    return { cls: 'status-text-amber', label: wStats.state.toUpperCase() };
  }

  let baseDurationSec = Number(initial.counters.duration_sec || 0);
  durationTimer = setInterval(() => {
    baseDurationSec++;
    const durEl = document.getElementById('kpi-dur');
    if (durEl) durEl.textContent = formatDuration(baseDurationSec);
  }, 1000);

  function renderMonitorData(data) {
    lastStateData = data;
    const c = data.counters;
    baseDurationSec = Number(c.duration_sec || 0);
    if (data.event.wall_key && String(data.event.wall_key) !== monitorWallKey) {
      monitorWallKey = String(data.event.wall_key);
      wallIframe.src = buildMonitorWallSrc(data.event, 'mon');
    } else if (Number(c.onair || 0) !== lastMonOnairCount) {
      pokeWallIframe(wallIframe);
    }
    lastMonOnairCount = Number(c.onair || 0);
    document.getElementById('kpi-joined').textContent = String(c.total_joined);
    document.getElementById('kpi-waiting').textContent = String(c.waiting);
    document.getElementById('kpi-onair').textContent = String(c.onair);
    document.getElementById('kpi-kicked').textContent = String(c.kicked_banned);
    document.getElementById('kpi-peak').textContent = String(c.peak_concurrent);
    document.getElementById('kpi-dur').textContent = formatDuration(baseDurationSec);

    const pgmBadge = document.getElementById('mon-pgm-badge');
    if (Number(data.event.blackout) === 1) {
      pgmBadge.className = 'status-text-red';
      pgmBadge.textContent = 'BLACKOUT';
    } else if (c.onair > 0) {
      pgmBadge.className = 'status-text-red';
      pgmBadge.textContent = `ON AIR (${c.onair} LIVE)`;
    } else {
      pgmBadge.className = 'status-text-green';
      pgmBadge.textContent = 'IDLE (QR SHOWING)';
    }

    const hb = data.wall_heartbeat;
    const hbState = document.getElementById('mon-hb-state');
    hbState.className = hb.online ? 'status-text-green' : 'status-text-red';
    hbState.textContent = hb.online ? 'ONLINE' : 'OFFLINE (>10s)';
    document.getElementById('mon-hb-details').textContent = hb.last_seen
      ? `Last seen: ${hb.age_sec}s ago · Res: ${hb.resolution || '?'} · Ver: ${hb.version || '?'}`
      : 'Waiting for OBS Browser Source to open the wall URL...';

    const alerts = data.alerts || [];
    const alertHash = JSON.stringify(alerts.map((a) => a.code + a.message));
    if (soundAlertsEnabled && alertHash !== lastAlertHash && alerts.some((a) => a.level === 'red')) {
      playBeep();
    }
    lastAlertHash = alertHash;

    const monAlertsEl = document.getElementById('mon-alerts');
    monAlertsEl.innerHTML = alerts.length === 0
      ? '<div class="adm-alert adm-alert-ok">All systems nominal.</div>'
      : alerts.map((a) => {
          const isTurn = (a.code === 'turn_error' || a.code === 'no_turn') && cfg.user.role === 'super_admin';
          return `<div class="adm-alert ${a.level === 'red' ? 'adm-alert-error' : 'adm-alert-warn'}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;"><span>${esc(a.message)}</span>${isTurn ? '<button type="button" class="btn btn-secondary btn-sm mon-turn-cfg">Configure TURN</button>' : ''}</div>`;
        }).join('');
    monAlertsEl.querySelectorAll('.mon-turn-cfg').forEach((btn) => {
      btn.addEventListener('click', () => openTurnConfigModal(() => refreshState()));
    });

    // On-air health & audio listen
    const onAir = (data.participants || []).filter((p) => p.status === 'onair');
    const healthList = document.getElementById('mon-health-list');
    if (onAir.length === 0) {
      healthList.innerHTML = '<div class="page-meta">No participants currently on air.</div>';
    } else {
      healthList.innerHTML = onAir.map((p) => {
        const ws = p.stats?.wall || p.stats?.audience || null;
        const hbInfo = healthBadge(ws);
        const res = ws && ws.width ? `${ws.width}x${ws.height}@${ws.fps}` : '—';
        const br = ws && ws.bitrate ? `${Math.round(ws.bitrate / 1000)} kbps` : '—';
        const loss = ws ? `${ws.packet_loss}%` : '—';
        const rtt = ws ? `${ws.rtt} ms` : '—';
        const relay = ws ? ws.relay_type.toUpperCase() : '—';
        const isListening = listeningPid === p.id;
        const capStr = formatCaptureSummary(p);
        return `
          <div class="health-row">
            <div>
              <strong>Slot ${p.slot_no}: ${esc(p.display_name)}</strong>
              ${capStr !== '—' ? `<div class="page-meta tabular" style="font-size:11.5px;">Phone: ${esc(capStr)}</div>` : ''}
            </div>
            <div class="${hbInfo.cls}">${hbInfo.label} · ${relay}</div>
            <div class="tabular">${res}</div>
            <div class="tabular">${br}</div>
            <div class="tabular">Loss ${loss} / ${rtt}</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <div class="meter-bar"><div class="meter-fill" id="hmeter-${p.id}"></div></div>
            </div>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn ${isListening ? 'btn-warning' : 'btn-secondary'} btn-sm h-listen" data-pid="${p.id}">
                ${isListening ? 'Stop Listen' : 'Listen'}
              </button>
              <button type="button" class="btn btn-ghost btn-sm h-remove" data-pid="${p.id}">Remove</button>
            </div>
          </div>
        `;
      }).join('');

      healthList.querySelectorAll('.h-listen').forEach((b) => {
        b.addEventListener('click', async () => {
          const pid = Number(b.dataset.pid);
          if (listeningPid === pid) {
            await stopPreviewSession(true);
            renderMonitorData(lastStateData);
          } else {
            activePreviewPid = pid;
            const pObj = onAir.find((x) => x.id === pid);
            pvLabel.textContent = `Listening to Slot feed #${pid}`;
            pvTakeBtn.disabled = true;
            pvStopBtn.disabled = false;
            pvListenBtn.disabled = false;
            pvListenBtn.textContent = 'Listen: On';
            pvTile.connEl.hidden = false;
            pvTile.connEl.textContent = 'Connecting preview...';
            updateWallTileAppearance(pvTile, {
              fitMode: pObj?.slot_fit_mode || data.event.wall_fit_mode || 'fit',
              tileBg: data.event.wall_tile_bg || 'blur',
              tileBgColor: data.event.wall_tile_bg_color || '#090d16',
              mirrored: Boolean(Number(data.event.mirror_front_wall || 0) === 1 && pObj?.facing_mode === 'user'),
              captureInfo: pObj?.capture_settings || null,
            });
            await startPrivatePreview(eventId, pid, {
              tile: pvTile,
              meterFillEl: document.getElementById(`hmeter-${pid}`) || pvMeter,
              unmuteAudio: true,
            });
            renderMonitorData(lastStateData);
          }
        });
      });

      healthList.querySelectorAll('.h-remove').forEach((b) => {
        b.addEventListener('click', async () => {
          await api(`/api/admin/events/${eventId}/wall-action`, { method: 'POST', json: { action: 'remove_from_wall', participant_id: Number(b.dataset.pid) } });
          pokeWallIframe(wallIframe);
          refreshMon();
        });
      });
    }

    // Waiting candidates
    const waiting = (data.participants || []).filter((p) => p.status === 'waiting');
    const candEl = document.getElementById('mon-candidates');
    candEl.innerHTML = waiting.length === 0
      ? '<div class="page-meta">Lobby is empty.</div>'
      : waiting.map((p) => {
        const capStr = formatCaptureSummary(p);
        return `
          <article class="part-card">
            <div class="part-thumb">
              ${p.has_thumb ? `<img src="/api/admin/events/${eventId}/participants/${p.id}/thumb?v=${p.thumb_version}" alt="${esc(p.display_name)}">` : '<div class="part-thumb-empty">No thumb</div>'}
            </div>
            <div class="part-body">
              <div class="part-name">${esc(p.display_name)}</div>
              ${capStr !== '—' ? `<div class="part-meta tabular">${esc(capStr)}</div>` : ''}
              <div class="part-actions">
                <button type="button" class="btn btn-secondary btn-sm c-prev" data-pid="${p.id}">Preview</button>
                <button type="button" class="btn btn-primary btn-sm c-air" data-pid="${p.id}">Put on Air</button>
              </div>
            </div>
          </article>
        `;
      }).join('');

    candEl.querySelectorAll('.c-prev').forEach((b) => {
      b.addEventListener('click', async () => {
        const pid = Number(b.dataset.pid);
        const p = waiting.find((x) => x.id === pid);
        activePreviewPid = pid;
        const capStr = p ? formatCaptureSummary(p) : '—';
        pvLabel.textContent = `Private Preview: ${p ? p.display_name : '#' + pid}${capStr !== '—' ? ` (${capStr})` : ''}`;
        pvTakeBtn.disabled = false;
        pvStopBtn.disabled = false;
        pvListenBtn.disabled = false;
        pvListenBtn.textContent = 'Listen: Off';
        pvTile.connEl.hidden = false;
        pvTile.connEl.textContent = 'Connecting preview...';
        updateWallTileAppearance(pvTile, {
          fitMode: 'fit',
          tileBg: data.event.wall_tile_bg || 'blur',
          tileBgColor: data.event.wall_tile_bg_color || '#090d16',
          mirrored: false,
          captureInfo: p?.capture_settings || null,
        });
        await startPrivatePreview(eventId, pid, { tile: pvTile, meterFillEl: pvMeter, unmuteAudio: false });
      });
    });

    candEl.querySelectorAll('.c-air').forEach((b) => {
      b.addEventListener('click', async () => {
        await api(`/api/admin/events/${eventId}/wall-action`, { method: 'POST', json: { action: 'put_on_wall', participant_id: Number(b.dataset.pid) } });
        pokeWallIframe(wallIframe);
        refreshMon();
      });
    });

    // Activity timeline
    document.getElementById('mon-timeline').innerHTML = (data.timeline || []).map((t) => `
      <div class="timeline-item">
        <span>${esc(t.message)}</span>
        <span class="tabular page-meta">${esc(t.created_at.slice(11, 19))}</span>
      </div>
    `).join('') || '<div class="page-meta">No activity yet.</div>';
  }

  async function refreshMon() {
    if (activeEventId !== eventId) return;
    try {
      const d = await api(`/api/admin/events/${eventId}/state`);
      renderMonitorData(d);
    } catch {}
  }

  renderMonitorData(initial);
  const loop = () => {
    if (activeEventId !== eventId) return;
    pollTimer = setTimeout(async () => {
      await refreshMon();
      loop();
    }, cfg.adminPollMs || 1500);
  };
  loop();
}

// ---------------- IMAGE BANK & PICKER MODAL ----------------

async function uploadImageFiles(fileList, visibility, tags) {
  const fd = new FormData();
  for (const f of fileList) fd.append('files[]', f);
  fd.append('visibility', visibility);
  fd.append('tags', tags);
  return api('/api/admin/images/upload', { method: 'POST', body: fd });
}

async function openLogoPickerModal(onSelect, modalTitle = 'Select QR Logo from Image Bank') {
  const data = await api('/api/admin/images');
  const images = data.images || [];
  openModal(`
    <div class="panel-head"><h2 style="margin:0;">${esc(modalTitle)}</h2><button type="button" class="btn btn-ghost btn-sm" id="lp-close">Close</button></div>
    <div class="dropzone" id="lp-dropzone">
      Drop PNG, JPG, WebP, or SVG here (max 2 MB) or click to upload directly to the Image Bank
      <input type="file" id="lp-file" accept=".png,.jpg,.jpeg,.webp,.svg,image/*" multiple hidden>
    </div>
    <div class="bank-grid" id="lp-grid">
      ${images.map((img) => `
        <div class="bank-card">
          <div class="bank-thumb"><img src="/uploads/logos/${esc(img.thumb_path)}" alt="${esc(img.label)}"></div>
          <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(img.label)}</div>
          <div class="page-meta">Used by ${img.use_count} event(s)</div>
          <button type="button" class="btn btn-primary btn-sm lp-pick" data-id="${img.id}">Select Image</button>
        </div>
      `).join('') || '<div class="page-meta">No images yet. Upload one above.</div>'}
    </div>
  `);
  document.getElementById('lp-close').addEventListener('click', closeModal);
  const dz = document.getElementById('lp-dropzone');
  const fi = document.getElementById('lp-file');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  const handleFiles = async (files) => {
    try {
      const res = await uploadImageFiles(files, 'shared', '');
      const first = res.uploaded?.[0]?.image;
      if (first) {
        if (res.uploaded[0].duplicate) toast('Duplicate detected — reusing existing image from bank');
        else toast('Uploaded to Image Bank');
        onSelect(first);
        closeModal();
      }
    } catch (err) {
      toast(err.message);
    }
  };
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  fi.addEventListener('change', () => { if (fi.files.length) handleFiles(fi.files); });

  modalEl.querySelectorAll('.lp-pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const img = images.find((x) => Number(x.id) === Number(btn.dataset.id));
      if (img) onSelect(img);
      closeModal();
    });
  });
}

async function renderImageBankView() {
  activeEventId = null;
  const canEdit = ['super_admin', 'host'].includes(cfg.user.role);
  let search = '';
  let sort = 'newest';

  mainEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Image Bank</h1>
        <div class="page-meta" id="ib-quota-text">Loading storage usage...</div>
      </div>
      <div style="width:240px;">
        <div class="quota-track"><div class="quota-fill" id="ib-quota-bar" style="width:0%;"></div></div>
      </div>
    </div>

    ${canEdit ? `
    <section class="panel" style="margin-bottom:16px;">
      <div class="dropzone" id="ib-dropzone">
        <strong>Drag &amp; drop logos here</strong> or click to select multiple files (PNG, JPG, WebP, SVG · max 2 MB each)
        <input type="file" id="ib-file" accept=".png,.jpg,.jpeg,.webp,.svg,image/*" multiple hidden>
      </div>
      <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;align-items:center;">
        <label class="field" style="flex-direction:row;align-items:center;gap:6px;">
          <span>Visibility</span>
          <select id="ib-vis" style="min-height:34px;width:auto;"><option value="shared">Shared with all admins</option><option value="private">Private to me</option></select>
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px;">
          <span>Tags</span>
          <input type="text" id="ib-tags" placeholder="sponsor, stage, 2026" style="min-height:34px;width:220px;">
        </label>
      </div>
    </section>
    ` : ''}

    <section class="panel">
      <div class="panel-head" style="flex-wrap:wrap;">
        <input type="search" id="ib-search" placeholder="Search label, tags, filename..." style="min-height:36px;padding:6px 12px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;min-width:260px;">
        <select id="ib-sort" style="min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
          <option value="newest">Sort: Newest</option>
          <option value="name">Sort: Name</option>
          <option value="used">Sort: Most Used</option>
        </select>
      </div>
      <div class="bank-grid" id="ib-grid"></div>
    </section>
  `;

  async function loadBank() {
    const data = await api(`/api/admin/images?q=${encodeURIComponent(search)}&sort=${encodeURIComponent(sort)}`);
    const pct = data.quota_bytes > 0 ? Math.min(100, Math.round((data.used_bytes / data.quota_bytes) * 100)) : 0;
    document.getElementById('ib-quota-text').textContent = `Storage: ${formatBytes(data.used_bytes)} / ${formatBytes(data.quota_bytes)} (${pct}%)`;
    document.getElementById('ib-quota-bar').style.width = `${pct}%`;

    const grid = document.getElementById('ib-grid');
    const images = data.images || [];
    if (images.length === 0) {
      grid.innerHTML = '<div class="page-meta" style="grid-column:1/-1;">No images found.</div>';
      return;
    }

    grid.innerHTML = images.map((img) => `
      <article class="bank-card">
        <div class="bank-thumb"><img src="/uploads/logos/${esc(img.thumb_path)}" alt="${esc(img.label)}"></div>
        <div style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(img.label)}</div>
        <div class="page-meta">${esc(img.uploader_name)} · ${esc(img.created_at.slice(0, 10))}</div>
        <div class="page-meta tabular">${img.width}x${img.height} · ${formatBytes(Number(img.size))} · Used by ${img.use_count} event(s)</div>
        <div class="page-meta">${Number(img.is_default) === 1 ? '<strong class="status-text-green">Default Logo</strong> · ' : ''}${esc(img.visibility)}</div>
        ${canEdit ? `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;">
          <button type="button" class="btn btn-secondary btn-sm ib-edit" data-id="${img.id}">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm ib-def" data-id="${img.id}">Set Default</button>
          <button type="button" class="btn btn-danger btn-sm ib-del" data-id="${img.id}">Delete</button>
        </div>
        ` : ''}
      </article>
    `).join('');

    grid.querySelectorAll('.ib-edit').forEach((b) => {
      b.addEventListener('click', () => {
        const img = images.find((x) => Number(x.id) === Number(b.dataset.id));
        if (!img) return;
        openModal(`
          <h2 style="margin:0;">Edit Image Metadata</h2>
          <form id="ib-edit-form" class="adm-auth-form">
            <label class="field"><span>Label</span><input type="text" id="ie-label" value="${esc(img.label)}" required maxlength="100"></label>
            <label class="field"><span>Tags</span><input type="text" id="ie-tags" value="${esc(img.tags)}" maxlength="200"></label>
            <label class="field"><span>Visibility</span><select id="ie-vis"><option value="shared" ${img.visibility === 'shared' ? 'selected' : ''}>Shared</option><option value="private" ${img.visibility === 'private' ? 'selected' : ''}>Private</option></select></label>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="button" class="btn btn-ghost" id="ie-cancel">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        `);
        document.getElementById('ie-cancel').addEventListener('click', closeModal);
        document.getElementById('ib-edit-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await api(`/api/admin/images/${img.id}`, {
            method: 'POST',
            json: {
              label: document.getElementById('ie-label').value,
              tags: document.getElementById('ie-tags').value,
              visibility: document.getElementById('ie-vis').value,
            },
          });
          closeModal();
          toast('Image updated');
          loadBank();
        });
      });
    });

    grid.querySelectorAll('.ib-def').forEach((b) => {
      b.addEventListener('click', async () => {
        await api(`/api/admin/images/${b.dataset.id}`, { method: 'POST', json: { is_default: true } });
        toast('Default logo updated for new events');
        loadBank();
      });
    });

    grid.querySelectorAll('.ib-del').forEach((b) => {
      b.addEventListener('click', async () => {
        const imgId = Number(b.dataset.id);
        try {
          await api(`/api/admin/images/${imgId}`, { method: 'DELETE' });
          toast('Image deleted');
          loadBank();
        } catch (err) {
          if (err.status === 409 && err.data?.in_use) {
            const others = images.filter((x) => Number(x.id) !== imgId);
            openModal(`
              <h2 style="margin:0;">Image In Use</h2>
              <p style="color:var(--text-secondary);">This image is used by: <strong>${err.data.events.map((e) => esc(e.title)).join(', ')}</strong>.</p>
              <label class="field">
                <span>Replace across all events with:</span>
                <select id="rep-select">
                  <option value="">(No logo)</option>
                  ${others.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}
                </select>
              </label>
              <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">
                <button type="button" class="btn btn-ghost" id="rep-cancel">Cancel</button>
                <button type="button" class="btn btn-warning" id="rep-only">Replace Everywhere Only</button>
                <button type="button" class="btn btn-danger" id="rep-del">Replace &amp; Delete</button>
              </div>
            `);
            document.getElementById('rep-cancel').addEventListener('click', closeModal);
            document.getElementById('rep-only').addEventListener('click', async () => {
              const repId = document.getElementById('rep-select').value;
              await api(`/api/admin/images/${imgId}/replace-everywhere`, { method: 'POST', json: { replacement_image_id: repId || null } });
              closeModal();
              toast('Replaced logo across events');
              loadBank();
            });
            document.getElementById('rep-del').addEventListener('click', async () => {
              const repId = document.getElementById('rep-select').value;
              await api(`/api/admin/images/${imgId}/replace-everywhere`, { method: 'POST', json: { replacement_image_id: repId || null } });
              await api(`/api/admin/images/${imgId}?force=1`, { method: 'DELETE' });
              closeModal();
              toast('Replaced and deleted image');
              loadBank();
            });
          } else {
            toast(err.message);
          }
        }
      });
    });
  }

  if (canEdit) {
    const dz = document.getElementById('ib-dropzone');
    const fi = document.getElementById('ib-file');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    const doUpload = async (files) => {
      try {
        const res = await uploadImageFiles(files, document.getElementById('ib-vis').value, document.getElementById('ib-tags').value);
        const dupCount = (res.uploaded || []).filter((r) => r.duplicate).length;
        const newCount = (res.uploaded || []).length - dupCount;
        toast(`Uploaded ${newCount} new, ${dupCount} duplicate(s) reused`);
        if (res.errors?.length) toast(res.errors.join(' | '));
        loadBank();
      } catch (err) {
        toast(err.message);
      }
    };
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files.length) doUpload(e.dataTransfer.files); });
    fi.addEventListener('change', () => { if (fi.files.length) doUpload(fi.files); fi.value = ''; });
  }

  document.getElementById('ib-search').addEventListener('input', (e) => { search = e.target.value; loadBank(); });
  document.getElementById('ib-sort').addEventListener('change', (e) => { sort = e.target.value; loadBank(); });
  loadBank();
}

// ---------------- VIEW: ACCOUNTS (SUPER ADMIN) ----------------

async function renderAccountsView() {
  activeEventId = null;
  if (cfg.user.role !== 'super_admin') {
    mainEl.innerHTML = `<div class="adm-alert adm-alert-error">Super Admin permission required.</div>`;
    return;
  }

  const [{ accounts }, { events }] = await Promise.all([api('/api/admin/accounts'), api('/api/admin/events')]);

  mainEl.innerHTML = `
    <div class="page-head">
      <div><h1>Accounts &amp; Permissions</h1><div class="page-meta">Manage Super Admins, Hosts, Moderators, and per-event access</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" id="acc-turn-btn">TURN / ICE Settings</button>
        <button type="button" class="btn btn-primary" id="acc-new-btn">Add Account</button>
      </div>
    </div>
    <section class="panel data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Username</th><th>Display Name</th><th>Email</th><th>Role</th><th>Scope</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
        <tbody>
          ${accounts.map((a) => `
            <tr>
              <td class="tabular">${esc(a.username)}</td>
              <td>${esc(a.display_name)}</td>
              <td>${esc(a.email)}</td>
              <td>${esc(a.role)}</td>
              <td>${a.event_scope === 'all' ? 'All events' : `${a.event_ids.length} assigned`}</td>
              <td class="${a.status === 'active' ? 'status-text-green' : 'status-text-red'}">${esc(a.status)}</td>
              <td class="tabular">${esc(a.last_login || 'Never')}</td>
              <td>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="btn btn-secondary btn-sm acc-edit" data-id="${a.id}">Edit</button>
                  <button type="button" class="btn btn-ghost btn-sm acc-pw" data-id="${a.id}">Reset PW</button>
                  <button type="button" class="btn btn-ghost btn-sm acc-rev" data-id="${a.id}">Revoke Sessions</button>
                  ${a.id !== cfg.user.id ? `<button type="button" class="btn btn-danger btn-sm acc-del" data-id="${a.id}">Delete</button>` : ''}
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `;

  function openAccountModal(existing = null) {
    const isEdit = !!existing;
    const assigned = new Set(existing?.event_ids || []);
    openModal(`
      <h2 style="margin:0;">${isEdit ? `Edit ${esc(existing.username)}` : 'Create Host / Moderator Account'}</h2>
      <form id="acc-form" class="adm-auth-form">
        ${isEdit ? '' : '<label class="field"><span>Username *</span><input type="text" id="af-user" required maxlength="64" placeholder="host_jane"></label>'}
        <label class="field"><span>Display Name *</span><input type="text" id="af-name" value="${esc(existing?.display_name || '')}" required maxlength="100"></label>
        <label class="field"><span>Email</span><input type="email" id="af-email" value="${esc(existing?.email || '')}" maxlength="190"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <label class="field">
            <span>Role</span>
            <select id="af-role">
              <option value="host" ${existing?.role === 'host' ? 'selected' : ''}>Host</option>
              <option value="moderator" ${existing?.role === 'moderator' ? 'selected' : ''}>Moderator</option>
              <option value="super_admin" ${existing?.role === 'super_admin' ? 'selected' : ''}>Super Admin</option>
            </select>
          </label>
          <label class="field">
            <span>Event Scope</span>
            <select id="af-scope">
              <option value="all" ${existing?.event_scope !== 'assigned' ? 'selected' : ''}>All events</option>
              <option value="assigned" ${existing?.event_scope === 'assigned' ? 'selected' : ''}>Assigned events only</option>
            </select>
          </label>
        </div>
        ${isEdit ? `
          <label class="field"><span>Status</span><select id="af-status"><option value="active" ${existing.status === 'active' ? 'selected' : ''}>Active</option><option value="disabled" ${existing.status === 'disabled' ? 'selected' : ''}>Disabled</option></select></label>
        ` : `
          <label class="field"><span>Temporary Password * (10+ chars, upper, lower, number; forced change on first login)</span><input type="password" id="af-pw" required minlength="10"></label>
        `}
        <div id="af-events-box" ${existing?.event_scope === 'assigned' ? '' : 'hidden'}>
          <div style="font-size:13px;font-weight:600;margin-bottom:6px;">Assigned Events</div>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:140px;overflow-y:auto;">
            ${events.map((ev) => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" class="af-ev-chk" value="${ev.id}" ${assigned.has(Number(ev.id)) ? 'checked' : ''}> ${esc(ev.title)}</label>`).join('')}
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="btn btn-ghost" id="af-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Account'}</button>
        </div>
      </form>
    `);
    document.getElementById('af-cancel').addEventListener('click', closeModal);
    document.getElementById('af-scope').addEventListener('change', (e) => {
      document.getElementById('af-events-box').hidden = e.target.value !== 'assigned';
    });
    document.getElementById('acc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const eventIds = Array.from(modalEl.querySelectorAll('.af-ev-chk:checked')).map((c) => Number(c.value));
      try {
        if (isEdit) {
          await api(`/api/admin/accounts/${existing.id}`, {
            method: 'POST',
            json: {
              display_name: document.getElementById('af-name').value,
              email: document.getElementById('af-email').value,
              role: document.getElementById('af-role').value,
              status: document.getElementById('af-status').value,
              event_scope: document.getElementById('af-scope').value,
              event_ids: eventIds,
            },
          });
          toast('Account updated');
        } else {
          await api('/api/admin/accounts', {
            method: 'POST',
            json: {
              username: document.getElementById('af-user').value,
              display_name: document.getElementById('af-name').value,
              email: document.getElementById('af-email').value,
              role: document.getElementById('af-role').value,
              event_scope: document.getElementById('af-scope').value,
              password: document.getElementById('af-pw').value,
              event_ids: eventIds,
            },
          });
          toast('Account created');
        }
        closeModal();
        renderAccountsView();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  document.getElementById('acc-turn-btn').addEventListener('click', () => openTurnConfigModal());
  document.getElementById('acc-new-btn').addEventListener('click', () => openAccountModal(null));
  mainEl.querySelectorAll('.acc-edit').forEach((b) => b.addEventListener('click', () => openAccountModal(accounts.find((x) => x.id === Number(b.dataset.id)))));
  mainEl.querySelectorAll('.acc-rev').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/accounts/${b.dataset.id}/revoke-sessions`, { method: 'POST' });
    toast('All sessions revoked');
  }));
  mainEl.querySelectorAll('.acc-del').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/accounts/${b.dataset.id}`, { method: 'DELETE' });
    toast('Account deleted');
    renderAccountsView();
  }));
  mainEl.querySelectorAll('.acc-pw').forEach((b) => b.addEventListener('click', () => {
    openModal(`
      <h2 style="margin:0;">Reset Account Password</h2>
      <form id="rp-form" class="adm-auth-form">
        <label class="field"><span>New Temporary Password (user forced to change on next login)</span><input type="password" id="rp-pw" required minlength="10"></label>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="btn btn-ghost" id="rp-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Reset Password</button>
        </div>
      </form>
    `);
    document.getElementById('rp-cancel').addEventListener('click', closeModal);
    document.getElementById('rp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/admin/accounts/${b.dataset.id}/reset-password`, { method: 'POST', json: { password: document.getElementById('rp-pw').value } });
        closeModal();
        toast('Password reset and sessions revoked');
      } catch (err) {
        toast(err.message);
      }
    });
  }));
}

// ---------------- VIEW: AUDIT LOG (SUPER ADMIN) ----------------

async function renderAuditView() {
  activeEventId = null;
  if (cfg.user.role !== 'super_admin') {
    mainEl.innerHTML = `<div class="adm-alert adm-alert-error">Super Admin permission required.</div>`;
    return;
  }

  const { events } = await api('/api/admin/events');
  let fEvent = '';
  let fQuery = '';

  mainEl.innerHTML = `
    <div class="page-head">
      <div><h1>Audit Log</h1><div class="page-meta">Chronological record of wall, participant, Image Bank, and account actions</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <select id="al-event" style="min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
          <option value="">All Events &amp; Global</option>
          ${events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('')}
        </select>
        <input type="search" id="al-q" placeholder="Filter actor, action, details..." style="min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;">
      </div>
    </div>
    <section class="panel data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Time (UTC)</th><th>Actor</th><th>Event</th><th>Action</th><th>Details</th></tr></thead>
        <tbody id="al-tbody"></tbody>
      </table>
    </section>
  `;

  async function loadAudit() {
    const data = await api(`/api/admin/audit?event_id=${encodeURIComponent(fEvent)}&q=${encodeURIComponent(fQuery)}`);
    document.getElementById('al-tbody').innerHTML = (data.logs || []).map((l) => `
      <tr>
        <td class="tabular">${esc(l.created_at)}</td>
        <td>${esc(l.admin_name)}</td>
        <td>${esc(l.event_title || 'Global')}</td>
        <td class="tabular">${esc(l.action)}</td>
        <td>${esc(l.details)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="color:var(--text-secondary);">No audit entries found.</td></tr>';
  }

  document.getElementById('al-event').addEventListener('change', (e) => { fEvent = e.target.value; loadAudit(); });
  document.getElementById('al-q').addEventListener('input', (e) => { fQuery = e.target.value; loadAudit(); });
  loadAudit();
}

// ---------------- CAMERA TELEMETRY & FRAME CHECK VIEW ----------------

function formatCaptureSummary(p) {
  const cap = p?.capture_settings;
  if (!cap || typeof cap !== 'object') {
    if (p?.facing_mode === 'user') return 'Front cam';
    if (p?.facing_mode === 'environment') return 'Rear cam';
    return '—';
  }
  const parts = [];
  const w = Number(cap.width || cap.videoWidth || 0);
  const h = Number(cap.height || cap.videoHeight || 0);
  if (w > 0 && h > 0) {
    parts.push(`${w}×${h}`);
    parts.push(formatAspectLabel(w, h));
  }
  if (cap.facingMode === 'user') parts.push('Front');
  else if (cap.facingMode === 'environment') parts.push('Rear');
  if (typeof cap.zoom === 'number') parts.push(`${cap.zoom.toFixed(1).replace(/\.0$/, '')}x`);
  if (cap.frameRate) parts.push(`${Math.round(Number(cap.frameRate))}fps`);
  return parts.length ? parts.join(' · ') : '—';
}

async function renderFrameCheckView() {
  activeEventId = null;
  let events = [];
  try {
    const evRes = await api('/api/admin/events');
    events = evRes.events || [];
  } catch {}

  const qs = new URLSearchParams(window.location.search);
  let selectedEventId = qs.get('event') ? Number(qs.get('event')) : (events[0]?.id ? Number(events[0].id) : 0);
  const canHost = ['super_admin', 'host'].includes(cfg.user.role);

  mainEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Frame Check &amp; Crop Diagnostics</h1>
        <div class="page-meta">Verify zero zoom &amp; zero crop across capture settings, Fit/Fill modes, and 1920×1080 OBS wall tiles</div>
      </div>
      <div class="page-actions">
        ${selectedEventId ? `<a href="/admin/events/${selectedEventId}" data-nav="/admin/events/${selectedEventId}" class="btn btn-secondary btn-sm">Back to Studio</a>` : ''}
      </div>
    </div>

    <div class="fc-layout">
      <section class="panel">
        <div class="panel-head" style="flex-wrap:wrap;">
          <h2 class="panel-title">16:9 Wall Tile Simulator (1920×1080 Scale)</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;">
              <input type="checkbox" id="fc-overlay-chk" checked> Show frame corners &amp; readout
            </label>
          </div>
        </div>
        <div class="fc-stage-16x9">
          <div class="wall-grid layout-single" id="fc-grid"></div>
        </div>
        <div class="page-meta" style="margin-top:8px;">
          Green corners indicate <strong>100% of the captured frame is visible</strong> (Fit mode). Amber corners indicate pixels are being cropped (Fill mode).
        </div>
      </section>

      <div style="display:flex;flex-direction:column;gap:12px;min-width:0;">
        <section class="panel" style="display:flex;flex-direction:column;gap:10px;">
          <div class="panel-head" style="margin-bottom:0;">
            <h2 class="panel-title">Source &amp; Display Settings</h2>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button type="button" class="btn btn-primary btn-sm" id="fc-cam-start-btn">Start Local Camera Test</button>
            <button type="button" class="btn btn-ghost btn-sm" id="fc-cam-stop-btn" hidden>Stop Local Camera</button>
            <select id="fc-cam-device" style="min-height:32px;flex:1;min-width:160px;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:#0d1422;color:#f8fafc;" hidden>
              <option value="">Default camera</option>
            </select>
          </div>

          <label class="field" id="fc-zoom-wrap" hidden>
            <span>Local Camera Zoom: <strong id="fc-zoom-val">1x</strong></span>
            <input type="range" id="fc-zoom-slider" min="1" max="1" step="0.1" value="1">
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <label class="field">
              <span>Inspect Event Feed</span>
              <select id="fc-event-select">
                <option value="">(None / Local Only)</option>
                ${events.map((ev) => `<option value="${ev.id}" ${Number(ev.id) === selectedEventId ? 'selected' : ''}>${esc(ev.title)}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span>Live Guest</span>
              <select id="fc-part-select">
                <option value="">Select connected guest...</option>
              </select>
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <label class="field">
              <span>Wall Layout</span>
              <select id="fc-layout">
                <option value="single">Single (1920×1080)</option>
                <option value="split2">Split 2</option>
                <option value="grid4">Grid 4</option>
                <option value="pip">Picture-in-Picture</option>
              </select>
            </label>
            <label class="field">
              <span>Fit Mode</span>
              <select id="fc-fit">
                <option value="fit">Fit (no crop, default)</option>
                <option value="fill">Fill (crops the picture)</option>
              </select>
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;">
            <label class="field">
              <span>Tile Background</span>
              <select id="fc-tilebg">
                <option value="blur">Blurred fill (default)</option>
                <option value="solid">Solid color</option>
                <option value="transparent">Transparent</option>
              </select>
            </label>
            <input type="color" id="fc-tilebg-color" value="#090d16" style="width:44px;height:36px;" hidden>
          </div>

          <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
            <input type="checkbox" id="fc-mirror"> Mirror front cameras on the wall
          </label>

          <details class="adv-details">
            <summary>Advanced display options</summary>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <input type="checkbox" id="fc-stretch"> Stretch video to fill tile (distorts aspect ratio)
            </label>
          </details>

          ${canHost ? `<button type="button" class="btn btn-secondary btn-sm" id="fc-save-event-btn" ${selectedEventId ? '' : 'disabled'}>Save Display Settings to Selected Event</button>` : ''}
        </section>

        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Live Frame Telemetry</h2></div>
          <div class="fc-metrics-grid">
            <div class="fc-metric-box"><div class="fc-metric-label">Captured Res</div><div class="fc-metric-val tabular" id="fc-m-cap">—</div></div>
            <div class="fc-metric-box"><div class="fc-metric-label">Stream Res</div><div class="fc-metric-val tabular" id="fc-m-stream">—</div></div>
            <div class="fc-metric-box"><div class="fc-metric-label">Aspect Ratio</div><div class="fc-metric-val tabular" id="fc-m-ar">—</div></div>
            <div class="fc-metric-box"><div class="fc-metric-label">Camera Zoom</div><div class="fc-metric-val tabular" id="fc-m-zoom">—</div></div>
            <div class="fc-metric-box"><div class="fc-metric-label">Tile @ Preview / OBS</div><div class="fc-metric-val tabular" id="fc-m-tile">—</div></div>
            <div class="fc-metric-box"><div class="fc-metric-label">Frame Visible</div><div class="fc-metric-val tabular" id="fc-m-vis">—</div></div>
          </div>
        </section>
      </div>
    </div>
  `;

  const gridEl = document.getElementById('fc-grid');
  const overlayChk = document.getElementById('fc-overlay-chk');
  const eventSel = document.getElementById('fc-event-select');
  const partSel = document.getElementById('fc-part-select');
  const layoutSel = document.getElementById('fc-layout');
  const fitSel = document.getElementById('fc-fit');
  const stretchChk = document.getElementById('fc-stretch');
  const tileBgSel = document.getElementById('fc-tilebg');
  const tileBgColEl = document.getElementById('fc-tilebg-color');
  const mirrorChk = document.getElementById('fc-mirror');
  const camStartBtn = document.getElementById('fc-cam-start-btn');
  const camStopBtn = document.getElementById('fc-cam-stop-btn');
  const camDevSel = document.getElementById('fc-cam-device');
  const zoomWrap = document.getElementById('fc-zoom-wrap');
  const zoomSlider = document.getElementById('fc-zoom-slider');
  const zoomVal = document.getElementById('fc-zoom-val');
  const saveEventBtn = document.getElementById('fc-save-event-btn');

  let localStream = null;
  let localCaptureInfo = null;
  let remoteParticipant = null;
  let remoteParticipants = [];
  let stageTiles = [];

  function activeFitMode() {
    return stretchChk.checked ? 'stretch' : fitSel.value;
  }

  function updateMetricsCards(metrics, capInfo) {
    if (!gridEl.isConnected) return;
    const capEl = document.getElementById('fc-m-cap');
    const streamEl = document.getElementById('fc-m-stream');
    const arEl = document.getElementById('fc-m-ar');
    const zoomEl = document.getElementById('fc-m-zoom');
    const tileEl = document.getElementById('fc-m-tile');
    const visEl = document.getElementById('fc-m-vis');
    if (!capEl || !streamEl || !arEl || !zoomEl) return;

    const cap = capInfo || localCaptureInfo || remoteParticipant?.capture_settings || {};
    const cw = Number(cap.width || metrics?.videoWidth || 0);
    const ch = Number(cap.height || metrics?.videoHeight || 0);
    capEl.textContent = cw && ch ? `${cw}×${ch}` : '—';
    streamEl.textContent = metrics?.videoWidth ? `${metrics.videoWidth}×${metrics.videoHeight}` : '—';
    arEl.textContent = metrics?.aspectLabel || (cw && ch ? formatAspectLabel(cw, ch) : '—');
    zoomEl.textContent = typeof cap.zoom === 'number' ? `${cap.zoom.toFixed(2).replace(/\.?0+$/, '')}x` : 'N/A';

    if (metrics && metrics.tileWidth > 0 && gridEl.clientWidth > 0) {
      const obsScale = 1920 / gridEl.clientWidth;
      const obsW = Math.round(metrics.tileWidth * obsScale);
      const obsH = Math.round(metrics.tileHeight * obsScale);
      if (tileEl) {
        tileEl.textContent = `${metrics.tileWidth}×${metrics.tileHeight} (OBS ${obsW}×${obsH})`;
      }
      if (visEl) {
        visEl.textContent = metrics.croppedPct > 0.5
          ? `${metrics.visiblePct}% (Cropped ${metrics.croppedPct}%)`
          : `${metrics.visiblePct}% (No crop)`;
        visEl.className = `fc-metric-val tabular ${metrics.croppedPct > 0.5 ? 'status-text-amber' : 'status-text-green'}`;
      }
    }
  }

  function rebuildTiles() {
    stageTiles.forEach((t) => t.destroy?.());
    const layout = layoutSel.value;
    gridEl.className = `wall-grid layout-${layout}`;
    const count = layout === 'single' ? 1 : (layout === 'split2' ? 2 : 4);
    gridEl.innerHTML = '';
    stageTiles = [];
    for (let i = 0; i < count; i++) {
      const t = createWallTile({
        onMetricsChange: i === 0 ? (m) => updateMetricsCards(m, localCaptureInfo || remoteParticipant?.capture_settings) : null,
      });
      t.root.dataset.pos = String(i);
      t.nameEl.textContent = i === 0 ? (remoteParticipant?.display_name || 'Frame Check Camera') : `Sample Slot ${i + 1}`;
      t.msgEl.hidden = true;
      t.connEl.textContent = i === 0 ? 'Start local camera or select a guest' : 'Layout preview slot';
      gridEl.appendChild(t.root);
      stageTiles.push(t);
    }
    syncTileStyles();
    const activeStream = localStream || previewPeer?.stream || null;
    if (activeStream && stageTiles[0]) {
      attachStreamToWallTile(stageTiles[0], activeStream);
      stageTiles[0].video.muted = true;
      stageTiles[0].video.play().catch(() => {});
    }
  }

  function syncTileStyles() {
    const fitMode = activeFitMode();
    const tileBg = tileBgSel.value;
    const tileBgColor = tileBgColEl.value;
    tileBgColEl.hidden = tileBg !== 'solid';
    const cap = localStream ? localCaptureInfo : (remoteParticipant?.capture_settings || null);
    const fm = localStream ? (localCaptureInfo?.facingMode || 'unknown') : (remoteParticipant?.facing_mode || 'unknown');
    const mirrored = mirrorChk.checked && fm === 'user';

    stageTiles.forEach((t, idx) => {
      updateWallTileAppearance(t, {
        fitMode,
        tileBg,
        tileBgColor,
        mirrored: idx === 0 ? mirrored : false,
        frameCheck: overlayChk.checked,
        captureInfo: idx === 0 ? cap : null,
      });
    });
    if (stageTiles[0]) {
      updateMetricsCards(computeVideoFrameMetrics(stageTiles[0].video, stageTiles[0].root, fitMode), cap);
    }
  }

  async function loadEventData(evId) {
    if (saveEventBtn) saveEventBtn.disabled = !evId;
    if (!evId) {
      remoteParticipants = [];
      partSel.innerHTML = '<option value="">Select connected guest...</option>';
      return;
    }
    try {
      const d = await api(`/api/admin/events/${evId}/state`);
      const ev = d.event;
      layoutSel.value = ev.layout || 'single';
      const fm = ev.wall_fit_mode || 'fit';
      fitSel.value = fm === 'fill' ? 'fill' : 'fit';
      stretchChk.checked = fm === 'stretch';
      tileBgSel.value = ev.wall_tile_bg || 'blur';
      tileBgColEl.value = ev.wall_tile_bg_color || '#090d16';
      mirrorChk.checked = Number(ev.mirror_front_wall || 0) === 1;
      remoteParticipants = d.participants || [];
      partSel.innerHTML = `<option value="">Select connected guest (${remoteParticipants.length})...</option>` +
        remoteParticipants.map((p) => `<option value="${p.id}">${esc(p.display_name)} (${esc(p.status)})</option>`).join('');
      rebuildTiles();
    } catch (err) {
      toast(err.message);
    }
  }

  function stopLocalCamera() {
    if (localStream) {
      localStream.getTracks().forEach((tr) => tr.stop());
      localStream = null;
    }
    localCaptureInfo = null;
    camStartBtn.hidden = false;
    camStopBtn.hidden = true;
    camDevSel.hidden = true;
    zoomWrap.hidden = true;
    if (stageTiles[0] && !previewPeer?.stream) {
      attachStreamToWallTile(stageTiles[0], null);
      stageTiles[0].connEl.hidden = false;
      stageTiles[0].connEl.textContent = 'Start local camera or select a guest';
    }
    syncTileStyles();
  }

  async function startLocalCamera(deviceId = '') {
    await stopPreviewSession(selectedEventId ? true : false);
    activeEventId = null;
    remoteParticipant = null;
    partSel.value = '';
    if (localStream) {
      localStream.getTracks().forEach((tr) => tr.stop());
    }
    const isPort = window.innerHeight > window.innerWidth;
    const vc = {
      width: { ideal: isPort ? 720 : 1280 },
      height: { ideal: isPort ? 1280 : 720 },
      frameRate: { ideal: 30 },
    };
    if (deviceId) vc.deviceId = { ideal: deviceId };
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
    } catch (err) {
      toast(`Camera failed: ${err.message}`);
      return;
    }
    const track = localStream.getVideoTracks()[0];
    if (track?.getCapabilities) {
      const caps = track.getCapabilities();
      if (caps?.zoom && typeof caps.zoom.min === 'number') {
        const minZ = caps.zoom.min;
        try { await track.applyConstraints({ advanced: [{ zoom: minZ }] }); } catch {}
        zoomSlider.min = String(caps.zoom.min);
        zoomSlider.max = String(caps.zoom.max);
        zoomSlider.step = String(caps.zoom.step || 0.1);
        zoomSlider.value = String(minZ);
        zoomVal.textContent = `${minZ.toFixed(1).replace(/\.0$/, '')}x`;
        zoomWrap.hidden = caps.zoom.max <= caps.zoom.min;
      } else {
        zoomWrap.hidden = true;
      }
    }
    const s = track?.getSettings ? track.getSettings() : {};
    localCaptureInfo = {
      width: Number(s.width || 0),
      height: Number(s.height || 0),
      frameRate: Number(s.frameRate || 0),
      aspectRatio: Number(s.aspectRatio || 0),
      facingMode: s.facingMode || 'unknown',
      zoom: typeof s.zoom === 'number' ? s.zoom : null,
      label: track?.label || '',
    };

    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter((d) => d.kind === 'videoinput');
      camDevSel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === s.deviceId ? 'selected' : ''}>${esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
      camDevSel.hidden = cams.length === 0;
    } catch {}

    camStartBtn.hidden = true;
    camStopBtn.hidden = false;
    if (stageTiles[0]) {
      stageTiles[0].nameEl.textContent = track?.label || 'Local Camera Test';
      attachStreamToWallTile(stageTiles[0], localStream);
      stageTiles[0].video.muted = true;
      stageTiles[0].video.play().catch(() => {});
    }
    syncTileStyles();
  }

  camStartBtn.addEventListener('click', () => startLocalCamera(camDevSel.value));
  camStopBtn.addEventListener('click', stopLocalCamera);
  camDevSel.addEventListener('change', () => startLocalCamera(camDevSel.value));
  zoomSlider.addEventListener('input', async () => {
    const track = localStream?.getVideoTracks?.()[0];
    const z = Number(zoomSlider.value);
    zoomVal.textContent = `${z.toFixed(1).replace(/\.0$/, '')}x`;
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: z }] });
        const s = track.getSettings();
        if (localCaptureInfo) {
          localCaptureInfo.zoom = typeof s.zoom === 'number' ? s.zoom : z;
          localCaptureInfo.width = Number(s.width || localCaptureInfo.width);
          localCaptureInfo.height = Number(s.height || localCaptureInfo.height);
        }
        syncTileStyles();
      } catch {}
    }
  });

  eventSel.addEventListener('change', () => {
    selectedEventId = eventSel.value ? Number(eventSel.value) : 0;
    loadEventData(selectedEventId);
  });

  partSel.addEventListener('change', async () => {
    const pid = partSel.value ? Number(partSel.value) : 0;
    stopLocalCamera();
    if (!pid || !selectedEventId) {
      activeEventId = null;
      remoteParticipant = null;
      await stopPreviewSession(true);
      rebuildTiles();
      return;
    }
    remoteParticipant = remoteParticipants.find((p) => p.id === pid) || null;
    activeEventId = selectedEventId;
    if (stageTiles[0]) {
      stageTiles[0].nameEl.textContent = remoteParticipant?.display_name || `Guest #${pid}`;
      stageTiles[0].connEl.hidden = false;
      stageTiles[0].connEl.textContent = 'Connecting WebRTC preview...';
    }
    await startPrivatePreview(selectedEventId, pid, { tile: stageTiles[0], unmuteAudio: false });
    syncTileStyles();
  });

  layoutSel.addEventListener('change', rebuildTiles);
  [fitSel, stretchChk, tileBgSel, tileBgColEl, mirrorChk, overlayChk].forEach((el) => {
    el.addEventListener('input', syncTileStyles);
    el.addEventListener('change', syncTileStyles);
  });

  if (saveEventBtn) {
    saveEventBtn.addEventListener('click', async () => {
      if (!selectedEventId) return;
      try {
        await api(`/api/admin/events/${selectedEventId}/settings`, {
          method: 'POST',
          json: {
            wall_fit_mode: activeFitMode(),
            wall_tile_bg: tileBgSel.value,
            wall_tile_bg_color: tileBgColEl.value,
            mirror_front_wall: mirrorChk.checked,
          },
        });
        toast('Display settings saved to event');
      } catch (err) {
        toast(err.message);
      }
    });
  }

  frameCheckCleanup = () => {
    stageTiles.forEach((t) => t.destroy?.());
    stageTiles = [];
    stopLocalCamera();
    activeEventId = null;
  };

  rebuildTiles();
  if (selectedEventId) {
    await loadEventData(selectedEventId);
  }
}

updateNavActive(currentRoute);
renderRoute();
