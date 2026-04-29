'use strict';

// ─── Presets definition ───────────────────────────────────────────────────────
const PRESETS = [
  { id: 'none',      icon: '🔇', name: 'Flat',        desc: 'No processing' },
  { id: '8d',        icon: '🌀', name: '8D Audio',     desc: 'Rotating spatial pan' },
  { id: 'concert',   icon: '🎭', name: 'Concert Hall', desc: 'Large reverb bloom' },
  { id: 'stadium',   icon: '🏟', name: 'Stadium',      desc: 'Huge open space echo' },
  { id: 'club',      icon: '🎧', name: 'Night Club',   desc: 'Punchy bass + reverb' },
  { id: 'cave',      icon: '🪨', name: 'Cave',         desc: 'Dark metallic reverb' },
  { id: 'bathroom',  icon: '🚿', name: 'Bathroom',     desc: 'Tight reflections' },
  { id: 'telephone', icon: '📞', name: 'Telephone',    desc: 'Filtered & distorted' },
  { id: 'bassboost', icon: '🔊', name: 'Bass Boost',   desc: 'Deep low-end lift' },
  { id: 'vaporwave', icon: '🌊', name: 'Vaporwave',    desc: 'Dreamy chorus reverb' },
];

// ─── State ────────────────────────────────────────────────────────────────────
// devices: [{ id, label, kind }]
// selected: [deviceId, ...]   ordered
// perDevice: { [deviceId]: { volume, eq:{bass,mid,treble}, effect } }
let devices     = [];
let selected    = [];
let perDevice   = {};
let enabled     = false;
let appliedTabId = null;
let fxTargetId  = null;   // which device the Effects panel is editing

const $ = id => document.getElementById(id);

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await restoreState();
  bindEvents();
  renderPresets();
  await scanDevices();
});

// ─── Storage ─────────────────────────────────────────────────────────────────
async function restoreState() {
  const d = await chrome.storage.local.get(['enabled', 'selected', 'perDevice']);
  enabled   = d.enabled   || false;
  selected  = d.selected  || [];
  perDevice = d.perDevice || {};
  syncPowerUI();
}
async function persist() {
  await chrome.storage.local.set({ enabled, selected, perDevice });
}

function deviceDefaults(id) {
  return perDevice[id] || { volume: 1.0, eq: { bass: 0, mid: 0, treble: 0 }, effect: 'none' };
}
function ensureDevice(id) {
  if (!perDevice[id]) perDevice[id] = deviceDefaults(id);
  return perDevice[id];
}

// ─── Device scan ──────────────────────────────────────────────────────────────
async function scanDevices() {
  $('refresh-btn').classList.add('spin');
  setStatus('', 'Scanning devices…');
  $('dev-list').innerHTML = '<div class="empty"><span class="ei">🔍</span>Scanning…</div>';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'ENUM_DEVICES' });
    if (resp?.error) throw new Error(resp.error);

    $('perm-banner').style.display = resp.devices.some(d => !d.label) ? 'block' : 'none';

    const seen = new Set();
    devices = (resp.devices || [])
      .filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
      .map(d => ({ id: d.id, label: d.label || friendlyId(d.id), kind: guessKind(d.label || d.id) }));

    selected = selected.filter(id => devices.some(d => d.id === id));

    if (!devices.length) {
      $('dev-list').innerHTML = '<div class="empty"><span class="ei">🔇</span>No outputs found.<br>Mixer and Effects still work on default output.</div>';
      setStatus('ok', 'Using default output');
    } else {
      renderDevices();
      setStatus('ok', `${devices.length} device${devices.length !== 1 ? 's' : ''} found`);
    }
    // Always render mixer and effects — they fall back to default when nothing selected
    renderMixer();
    renderFxDeviceSelect();
  } catch (e) {
    $('dev-list').innerHTML = '<div class="empty"><span class="ei">⚠️</span>Scan failed.<br>Open a media tab and try again.</div>';
    setStatus('err', 'Scan failed — try YouTube / Spotify');
  }

  $('refresh-btn').classList.remove('spin');
  updateApplyBtn();
}

// ─── Render: device list (Outputs tab) ───────────────────────────────────────
function renderDevices() {
  const list = $('dev-list');
  list.innerHTML = '';
  devices.forEach((dev, i) => {
    const isSel    = selected.includes(dev.id);
    const isDupRisk = isSel && dev.id === 'default' && selected.length > 1;
    const card = document.createElement('div');
    card.className = 'dev-card' + (isSel ? ' sel' : '');
    card.style.animationDelay = (i * 38) + 'ms';
    card.innerHTML = `
      <div class="dev-ico">${kindEmoji(dev.kind)}</div>
      <div class="dev-meta">
        <div class="dev-name">${esc(dev.label)}</div>
        <div class="dev-sub">${dev.kind} · ${dev.id === 'default' ? 'system alias' : '···' + dev.id.slice(-7)}</div>
      </div>
      ${isDupRisk ? '<div class="dev-warn">may echo</div>' : ''}
      <div class="chk">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          <path d="M1 4.5L3.5 7L8 1.5" stroke="#0d0014" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>`;
    card.addEventListener('click', e => { spawnRipple(card, e); toggleDevice(dev.id); });
    list.appendChild(card);
  });
  updateSelBadge();
}

function toggleDevice(id) {
  const idx = selected.indexOf(id);
  if (idx >= 0) selected.splice(idx, 1);
  else { selected.push(id); ensureDevice(id); }
  renderDevices();
  renderMixer();
  renderFxDeviceSelect();
  syncPowerUI();
  updateApplyBtn();
  persist();
}

// ─── Mixer helpers ────────────────────────────────────────────────────────────
// Returns list of {uiId, realId, label, kind} to show in Mixer/Effects.
// If nothing is selected we still show the Default output strip.
function mixerEntries() {
  if (selected.length > 0) {
    return selected.map(id => {
      const dev = devices.find(d => d.id === id);
      return { uiId: id, realId: id, label: dev ? dev.label : friendlyId(id), kind: dev ? dev.kind : 'speaker' };
    });
  }
  return [{ uiId: '__default__', realId: 'default', label: 'Default output', kind: 'system' }];
}

// ─── Render: mixer strips ─────────────────────────────────────────────────────
function renderMixer() {
  const wrap = $('mixer-scroll');
  wrap.innerHTML = '';
  mixerEntries().forEach(({ uiId, realId, label, kind }) => {
    const pd     = ensureDevice(realId);
    const volPct = Math.round(pd.volume * 100);

    const strip = document.createElement('div');
    strip.className = 'ch-strip active';
    strip.dataset.deviceId = uiId;
    strip.innerHTML = `
      <div class="ch-header">
        <span class="ch-ico">${kindEmoji(kind)}</span>
        <span class="ch-label">${esc(label)}</span>
        <span class="ch-vol-badge">${volPct}%</span>
        <svg class="ch-expand" width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M1.5 3.5L5.5 7.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="ch-body">
        <div class="vol-row">
          <div class="vol-lbl">Vol</div>
          <div class="vol-trk">
            <div class="vol-bg"><div class="vol-fill" style="width:${volPct}%"></div></div>
            <input type="range" class="slider vol-slider" min="0" max="100" value="${volPct}" data-id="${esc(realId)}">
          </div>
          <div class="vol-pct">${volPct}%</div>
        </div>
        <div class="eq-section">
          <div class="eq-title">EQ (dB)</div>
          ${makeEqRow('Bass',   'bass',   pd.eq.bass,   realId, 'bass')}
          ${makeEqRow('Mid',    'mid',    pd.eq.mid,    realId, 'mid')}
          ${makeEqRow('Treble', 'treble', pd.eq.treble, realId, 'treble')}
        </div>
      </div>`;

    strip.querySelector('.ch-header').addEventListener('click', () => strip.classList.toggle('open'));

    const volSlider = strip.querySelector('.vol-slider');
    const volFill   = strip.querySelector('.vol-fill');
    const volPctEl  = strip.querySelector('.vol-pct');
    const volBadge  = strip.querySelector('.ch-vol-badge');
    volSlider.addEventListener('input', () => {
      const v = parseInt(volSlider.value);
      volFill.style.width  = v + '%';
      volPctEl.textContent = v + '%';
      volBadge.textContent = v + '%';
      ensureDevice(realId).volume = v / 100;
      pushLiveParams();
      persist();
    });

    ['bass','mid','treble'].forEach(band => {
      const sl     = strip.querySelector(`.eq-slider[data-band="${band}"]`);
      const fillEl = strip.querySelector(`.eq-fill.${band}`);
      const valEl  = strip.querySelector(`.eq-val[data-band="${band}"]`);
      if (!sl) return;
      sl.addEventListener('input', () => {
        const db = parseInt(sl.value);
        valEl.textContent = (db >= 0 ? '+' : '') + db;
        updateEqFill(fillEl, db);
        ensureDevice(realId).eq[band] = db;
        pushLiveParams();
        persist();
      });
    });

    wrap.appendChild(strip);
  });
}
function makeEqRow(label, band, val, id, cls) {
  const db  = Math.round(val || 0);
  const dbStr = (db >= 0 ? '+' : '') + db;
  return `
    <div class="eq-row">
      <div class="eq-lbl">${label}</div>
      <div class="eq-trk">
        <div class="eq-bg"></div>
        <div class="eq-mid-line"></div>
        <div class="eq-fill ${cls}" style="${eqFillStyle(db)}"></div>
        <input type="range" class="eq-slider" min="-15" max="15" value="${db}" data-band="${band}" data-id="${esc(id)}">
      </div>
      <div class="eq-val" data-band="${band}">${dbStr}</div>
    </div>`;
}

function eqFillStyle(db) {
  // Fill from center (50%) — positive goes right, negative goes left
  const pct  = Math.abs(db) / 15 * 50;
  const left  = db < 0 ? (50 - pct) + '%' : '50%';
  const width = pct + '%';
  return `left:${left};width:${width};top:0;bottom:0;border-radius:3px`;
}

function updateEqFill(fillEl, db) {
  const pct   = Math.abs(db) / 15 * 50;
  const left  = db < 0 ? (50 - pct) + '%' : '50%';
  fillEl.style.left  = left;
  fillEl.style.width = pct + '%';
}

// ─── Render: Effects panel ────────────────────────────────────────────────────
function renderPresets() {
  const grid = $('presets-grid');
  grid.innerHTML = '';
  PRESETS.forEach(p => {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.dataset.preset = p.id;
    card.innerHTML = `
      <span class="preset-icon">${p.icon}</span>
      <div class="preset-name">${p.name}</div>
      <div class="preset-desc">${p.desc}</div>`;
    card.addEventListener('click', () => selectPreset(p.id));
    grid.appendChild(card);
  });
}

function renderFxDeviceSelect() {
  const sel = $('fx-device-select');
  sel.innerHTML = '';
  // Always populate — use mixerEntries() so default appears when nothing selected
  const entries = mixerEntries();
  entries.forEach(({ uiId, realId, label }) => {
    const opt = document.createElement('option');
    opt.value = realId;
    opt.textContent = label;
    sel.appendChild(opt);
  });
  // Pick fxTargetId: keep it if still valid, else use first
  const validIds = entries.map(e => e.realId);
  if (!fxTargetId || !validIds.includes(fxTargetId)) fxTargetId = validIds[0];
  sel.value = fxTargetId;
  updatePresetHighlight();
}
function selectPreset(id) {
  // fxTargetId is always set (default if nothing selected)
  const tid = fxTargetId || 'default';
  ensureDevice(tid).effect = id;
  fxTargetId = tid;
  updatePresetHighlight();
  pushLiveParams();
  persist();
}

function updatePresetHighlight() {
  const tid = fxTargetId || 'default';
  const current = ensureDevice(tid).effect || 'none';
  document.querySelectorAll('.preset-card').forEach(c => {
    c.classList.toggle('sel', c.dataset.preset === current);
  });
}

// ─── Power ────────────────────────────────────────────────────────────────────
function syncPowerUI() {
  const strip = $('power-strip');
  const sub   = $('pw-sub');
  const pill  = $('live-pill');
  const isLive = enabled && !!appliedTabId;

  strip.classList.toggle('on', enabled);
  pill.classList.toggle('on', isLive);

  if (!enabled)           sub.textContent = 'Off — tap to enable';
  else if (!appliedTabId) sub.textContent = selected.length >= 2 ? `Ready · ${selected.length} outputs` : 'On — apply to activate';
  else                    sub.textContent = selected.length >= 2 ? `Live · ${selected.length} outputs` : 'Live · default output';
}

// ─── Bind events ──────────────────────────────────────────────────────────────
function bindEvents() {
  $('power-strip').addEventListener('click', () => {
    enabled = !enabled;
    syncPowerUI(); updateApplyBtn(); persist();
    if (!enabled && appliedTabId) { pushConfig(appliedTabId); appliedTabId = null; }
  });

  $('apply-btn').addEventListener('click', applyToTab);
  $('refresh-btn').addEventListener('click', scanDevices);
  $('grant-perm').addEventListener('click', scanDevices);

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Effects device selector
  $('fx-device-select').addEventListener('change', e => {
    fxTargetId = e.target.value;
    updatePresetHighlight();
  });
}

// ─── Apply to tab ─────────────────────────────────────────────────────────────
async function applyToTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { setStatus('err', 'No active tab found'); return; }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const result = await pushConfig(tab.id);
    appliedTabId = tab.id;

    const count = result?.count ?? 0;
    const outLabel = selected.length >= 2 ? `${selected.length} outputs` : 'default output';
    setStatus('act', count > 0
      ? `Routing ${count} element${count !== 1 ? 's' : ''} → ${outLabel}`
      : 'Applied — start playback to activate');
    syncPowerUI();

    // Flash button
    const btn = $('apply-btn');
    btn.textContent = '✓ Applied';
    btn.classList.add('ok-flash');
    setTimeout(() => { updateApplyBtn(); btn.classList.remove('ok-flash'); }, 2000);
  } catch (e) {
    setStatus('err', 'Failed — try on a YouTube or Spotify tab');
  }
}

// Build and send full config to the content script
async function pushConfig(tabId) {
  // Use selected devices, or fall back to default output if none chosen
  const entries = mixerEntries();
  const sinks = entries.map(({ realId }) => {
    const pd = ensureDevice(realId);
    return { deviceId: realId, volume: pd.volume, eq: pd.eq, effect: pd.effect || 'none' };
  });
  const cfg = { enabled, sinks };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'DUAL_AUDIO_CONFIG', config: cfg });
  } catch (e) {
    console.warn('[popup] pushConfig:', e.message);
    return null;
  }
}

// Live param update (no teardown, no re-route — just update node values)
async function pushLiveParams() {
  if (!appliedTabId || !enabled) return;
  const entries = mixerEntries();
  const sinks = entries.map(({ realId }) => {
    const pd = ensureDevice(realId);
    return { deviceId: realId, volume: pd.volume, eq: pd.eq, effect: pd.effect || 'none' };
  });
  try {
    await chrome.tabs.sendMessage(appliedTabId, { type: 'UPDATE_PARAMS', sinks });
  } catch (_) {}
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function updateApplyBtn() {
  const btn   = $('apply-btn');
  const ready = enabled && selected.length >= 2;
  btn.disabled = !enabled;
  if (!enabled) btn.textContent = 'Enable first — toggle the power';
  else          btn.textContent = selected.length >= 2 ? 'Apply to active tab' : 'Apply to active tab (default output)';
}

function updateSelBadge() {
  const b = $('sel-badge');
  b.textContent = selected.length ? `${selected.length} selected` : '0 selected';
  b.classList.toggle('has', selected.length > 0);
}

function setStatus(type, msg) {
  const row = $('status-row');
  row.className = 'status-row' + (type ? ' ' + type : '');
  $('st-msg').textContent = msg;
}

function spawnRipple(el, e) {
  const r = document.createElement('span');
  r.className = 'ripple';
  const rect = el.getBoundingClientRect();
  const sz = Math.max(rect.width, rect.height) * 1.3;
  r.style.cssText = `width:${sz}px;height:${sz}px;left:${e.clientX-rect.left-sz/2}px;top:${e.clientY-rect.top-sz/2}px`;
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function guessKind(label) {
  const l = (label || '').toLowerCase();
  if (l.includes('hdmi') || l.includes('display') || l.includes('monitor') || l.includes('tv')) return 'hdmi';
  if (l.includes('headphone') || l.includes('analog') || l.includes('jack') || l.includes('3.5') || l.includes('aux')) return 'jack';
  if (l.includes('bluetooth') || l.includes('wireless')) return 'bluetooth';
  if (l.includes('usb')) return 'usb';
  if (l.includes('default') || l.includes('communications')) return 'system';
  return 'speaker';
}
function kindEmoji(k) { return {hdmi:'🖥',jack:'🎧',bluetooth:'📶',usb:'🔌',system:'⚙️',speaker:'🔊'}[k]||'🔊'; }
function friendlyId(id) { return id === 'default' ? 'System default' : id === 'communications' ? 'Communications' : 'Device ' + id.slice(-4).toUpperCase(); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
