// State
let profiles = [];
let selectedProfileIds = new Set();
let editingProfileId = null;
let currentFingerprint = null;
let isPolling = false;
let currentView = 'profiles';
let systemInfo = null;

// Toast Notification
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-triangle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastSlide 0.2s reverse forwards';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// Helper: Escape HTML
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helper: Clipboard copy
function copyToClipboard(text, label = 'Text') {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`${label} copied to clipboard!`, 'success', 2000);
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

// -------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------
async function init() {
  console.log('Initializing Orbita Anti-Detect UI...');
  setupModalDismissals();
  setupEventListeners();
  
  await loadSystemInfo();
  await loadProfiles();

  // Periodic polling for running status
  setInterval(async () => {
    if (!isPolling && !editingProfileId) {
      await loadProfiles(false);
    }
  }, 3000);
}

async function loadSystemInfo() {
  try {
    const res = await fetch('/api/system-info');
    systemInfo = await res.json();
    const data = systemInfo;
    const engineText = document.getElementById('engine-status-text');
    const engineDetails = document.getElementById('engine-details-text');
    
    if (data.engines && data.engines.length > 0) {
      const def = data.engines[0];
      engineText.textContent = def.name.split('(')[0].trim();
      engineDetails.textContent = `${data.engines.length} Engine(s) Available`;
    } else {
      engineText.textContent = 'Chrome Stealth Mode';
      engineDetails.textContent = 'Standard Command Flags';
    }

    if (currentView === 'engines') {
      renderEnginesView();
    }
  } catch (err) {
    console.error('System info fetch error:', err);
  }
}

async function loadProfiles(showLoader = true) {
  isPolling = true;
  const tbody = document.getElementById('profiles-table-body');
  
  if (showLoader && profiles.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-12">
          <div class="loading-spinner"></div>
          <p class="text-muted mt-2">Loading profiles...</p>
        </td>
      </tr>
    `;
  }

  try {
    const res = await fetch('/api/profiles');
    profiles = await res.json();
    
    // Update badge & stats
    document.getElementById('stat-total').textContent = profiles.length;
    document.getElementById('sidebar-total-badge').textContent = profiles.length;
    const runningCount = profiles.filter(p => p.isRunning).length;
    document.getElementById('stat-running').textContent = runningCount;

    renderProfilesTable();
    if (currentView === 'proxies') {
      renderProxyManager();
    }
  } catch (err) {
    console.error('Failed to load profiles:', err);
    showToast('Failed to load profiles: ' + err.message, 'error');
  } finally {
    isPolling = false;
  }
}

// -------------------------------------------------------------
// TABLE RENDERING & FILTERING
// -------------------------------------------------------------
function renderProfilesTable() {
  const tbody = document.getElementById('profiles-table-body');
  const searchInput = document.getElementById('search-input');
  const filterStatus = document.getElementById('filter-status').value;
  const filterEngine = document.getElementById('filter-engine').value;
  const query = searchInput.value.toLowerCase().trim();

  // Filter profiles
  const filtered = profiles.filter(p => {
    // Search query
    const matchSearch = !query || 
      p.name.toLowerCase().includes(query) ||
      (p.tags && p.tags.some(t => t.toLowerCase().includes(query))) ||
      (p.proxy && p.proxy.host && p.proxy.host.toLowerCase().includes(query)) ||
      (p.notes && p.notes.toLowerCase().includes(query));

    // Status filter
    let matchStatus = true;
    if (filterStatus === 'running') matchStatus = p.isRunning === true;
    if (filterStatus === 'stopped') matchStatus = !p.isRunning;

    // Engine filter
    let matchEngine = true;
    if (filterEngine !== 'all') matchEngine = p.engine === filterEngine;

    return matchSearch && matchStatus && matchEngine;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-12">
          <i class="fa-solid fa-ghost text-muted" style="font-size: 32px; margin-bottom: 12px; display: block;"></i>
          <p class="text-muted">
            ${profiles.length === 0 ? 'No profiles yet. Click "+ New Profile" or "Bulk Add" above to start!' : 'No profiles match your filter criteria.'}
          </p>
        </td>
      </tr>
    `;
    updateBulkBar();
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    const isSelected = selectedProfileIds.has(p.id);
    const isRunning = p.isRunning;
    
    // Proxy string
    let proxyHtml = `<span class="text-muted"><i class="fa-solid fa-globe"></i> Direct</span>`;
    if (p.proxy && p.proxy.mode !== 'none' && p.proxy.host) {
      const mode = p.proxy.mode.toUpperCase();
      const ipPort = `${p.proxy.host}:${p.proxy.port}`;
      proxyHtml = `
        <div class="proxy-cell-content">
          <i class="fa-solid fa-shield-halved text-green"></i>
          <span class="proxy-ip-copy" title="Click to copy proxy" onclick="copyToClipboard('${escapeHtml(ipPort)}', 'Proxy')">${escapeHtml(ipPort)}</span>
        </div>
      `;
    }

    // Engine badge - Orbita by default
    let engineType = 'orbita';
    let engineLabel = 'Orbita';
    let engineIcon = 'fa-solid fa-shield-halved';

    if (p.engine === 'chrome') {
      engineType = 'chrome';
      engineLabel = 'Chrome';
      engineIcon = 'fa-brands fa-chrome';
    } else if (p.engine === 'edge') {
      engineType = 'edge';
      engineLabel = 'Edge';
      engineIcon = 'fa-brands fa-edge';
    } else if (p.engine === 'camoufox') {
      engineType = 'camoufox';
      engineLabel = 'Camoufox';
      engineIcon = 'fa-solid fa-shield-cat';
    }

    // Hardware Specs Chip
    const fp = p.fingerprint || {};
    const osIcon = (fp.os && fp.os.includes('Mac')) ? 'fa-apple' : (fp.os && fp.os.includes('Linux') ? 'fa-linux' : 'fa-windows');
    const res = fp.screenResolution || '1080p';
    const cores = fp.cpuCores || 8;
    const ram = fp.ramGb || 16;
    const gpu = fp.webglRenderer ? fp.webglRenderer.replace(/ANGLE \((.*?),/, '$1').trim() : 'NVIDIA RTX';

    // Tags
    const tagsHtml = (p.tags && p.tags.length > 0)
      ? p.tags.map(t => `<span class="tag-badge">#${escapeHtml(t)}</span>`).join('')
      : '';

    return `
      <tr class="${isSelected ? 'selected' : ''}" data-id="${p.id}">
        <td class="text-center">
          <input type="checkbox" class="profile-row-checkbox" data-id="${p.id}" ${isSelected ? 'checked' : ''}>
        </td>
        <td>
          <div class="profile-cell">
            <div class="profile-title-row">
              <i class="fa-brands ${osIcon} text-muted" title="${escapeHtml(fp.os || 'Windows')}"></i>
              <strong class="profile-name">${escapeHtml(p.name)}</strong>
            </div>
            ${tagsHtml ? `<div class="profile-tags">${tagsHtml}</div>` : ''}
          </div>
        </td>
        <td>
          <span class="engine-badge ${engineType}">
            <i class="${engineIcon}"></i> ${engineLabel}
          </span>
        </td>
        <td>
          <span class="status-badge ${isRunning ? 'running' : 'stopped'}">
            ${isRunning ? '<span class="live-dot"></span>' : '<span style="font-size: 8px;">⚪</span>'}
            ${isRunning ? 'Running' : 'Stopped'}
          </span>
        </td>
        <td>${proxyHtml}</td>
        <td>
          <div class="fp-cell">
            <div class="fp-chips">
              <span class="fp-chip" title="Resolution">${escapeHtml(res)}</span>
              <span class="fp-chip" title="Hardware">${cores}C / ${ram}GB</span>
            </div>
            <span class="fp-gpu-sub" title="${escapeHtml(fp.webglRenderer || '')}">${escapeHtml(gpu)}</span>
          </div>
        </td>
        <td>
          <span class="text-muted text-xs">
            ${p.lastLaunched ? new Date(p.lastLaunched).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never'}
          </span>
        </td>
        <td>
          <div class="table-actions">
            ${isRunning ? `
              <button class="btn btn-sm btn-danger" onclick="stopSingleProfile('${p.id}')" title="Stop Profile">
                <i class="fa-solid fa-stop"></i> Stop
              </button>
            ` : `
              <button class="btn btn-sm btn-success" onclick="startSingleProfile('${p.id}')" title="Start Anti-Detect Browser">
                <i class="fa-solid fa-play"></i> Start
              </button>
            `}
            <button class="action-icon-btn" onclick="openProfileFolder('${p.id}')" title="Open Data Folder in Explorer">
              <i class="fa-solid fa-folder-open"></i>
            </button>
            <button class="action-icon-btn" onclick="openEditModal('${p.id}')" title="Edit Profile & Fingerprint">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="action-icon-btn" onclick="cloneSingleProfile('${p.id}')" title="Clone with New Fingerprint">
              <i class="fa-solid fa-clone"></i>
            </button>
            <button class="action-icon-btn delete-btn" onclick="deleteSingleProfile('${p.id}')" title="Delete Profile">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  updateBulkBar();
}

// -------------------------------------------------------------
// SELECTION & BULK ACTIONS
// -------------------------------------------------------------
function updateBulkBar() {
  const bulkBar = document.getElementById('bulk-bar');
  const countEl = document.getElementById('bulk-selected-count');
  const masterCheck = document.getElementById('select-all-checkbox');
  const size = selectedProfileIds.size;

  countEl.textContent = size;

  if (size > 0) {
    bulkBar.style.display = 'flex';
  } else {
    bulkBar.style.display = 'none';
  }

  // Update master checkbox state
  if (profiles.length === 0) {
    masterCheck.checked = false;
    masterCheck.indeterminate = false;
  } else if (size === profiles.length) {
    masterCheck.checked = true;
    masterCheck.indeterminate = false;
  } else if (size > 0) {
    masterCheck.checked = false;
    masterCheck.indeterminate = true;
  } else {
    masterCheck.checked = false;
    masterCheck.indeterminate = false;
  }
}

function handleRowCheckboxClick(e) {
  const target = e.target;
  const checkbox = (target && target.matches && target.matches('.profile-row-checkbox'))
    ? target
    : (target && target.closest ? target.closest('.profile-row-checkbox') : null);

  if (!checkbox || !checkbox.dataset.id) return;

  const id = checkbox.dataset.id;
  console.log('handleRowCheckboxClick for id:', id, 'checked:', checkbox.checked);

  if (checkbox.checked) {
    selectedProfileIds.add(id);
  } else {
    selectedProfileIds.delete(id);
  }

  const row = checkbox.closest('tr');
  if (row) row.classList.toggle('selected', checkbox.checked);

  updateBulkBar();
}

function handleSelectAll(e) {
  const isChecked = e.target.checked;
  selectedProfileIds.clear();

  if (isChecked) {
    profiles.forEach(p => selectedProfileIds.add(p.id));
  }

  renderProfilesTable();
}

function deselectAll() {
  selectedProfileIds.clear();
  renderProfilesTable();
}

// -------------------------------------------------------------
// PROFILE LAUNCH / STOP / OPERATIONS
// -------------------------------------------------------------
async function startSingleProfile(id) {
  showToast('Launching stealth browser...', 'info', 2000);
  try {
    const res = await fetch(`/api/profiles/${id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://browserleaks.com' })
    });
    const data = await res.json();
    if (data.error) {
      showToast('Launch failed: ' + data.error, 'error', 4000);
    } else {
      showToast(`Started profile with ${data.engine}!`, 'success', 3000);
    }
    await loadProfiles(false);
  } catch (err) {
    showToast('Launch error: ' + err.message, 'error');
  }
}

async function stopSingleProfile(id) {
  showToast('Stopping browser...', 'info', 1500);
  try {
    const res = await fetch(`/api/profiles/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    showToast('Browser profile stopped', 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Failed to stop browser: ' + err.message, 'error');
  }
}

async function cloneSingleProfile(id) {
  showToast('Cloning profile with new fingerprint...', 'info', 1500);
  try {
    const res = await fetch(`/api/profiles/${id}/clone`, { method: 'POST' });
    const data = await res.json();
    showToast(`Cloned as "${data.name}"`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Failed to clone: ' + err.message, 'error');
  }
}

async function deleteSingleProfile(id) {
  const p = profiles.find(item => item.id === id);
  const name = p ? p.name : 'this profile';

  if (!window.confirm(`Are you sure you want to permanently delete "${name}" and all its isolated cookies & data?`)) {
    return;
  }

  try {
    await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    selectedProfileIds.delete(id);
    showToast('Profile deleted successfully', 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Delete error: ' + err.message, 'error');
  }
}

async function openProfileFolder(id) {
  try {
    await fetch(`/api/profiles/${id}/open-folder`, { method: 'POST' });
    showToast('Opening folder in Windows Explorer', 'info', 2000);
  } catch (err) {
    showToast('Could not open folder', 'error');
  }
}

// -------------------------------------------------------------
// BULK EXECUTION HANDLERS
// -------------------------------------------------------------
async function executeBulkStart() {
  const ids = Array.from(selectedProfileIds);
  if (ids.length === 0) return;

  showToast(`Starting ${ids.length} browser profiles...`, 'info', 2500);
  try {
    const res = await fetch('/api/profiles/bulk-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const data = await res.json();
    showToast(`Started ${data.started.length} profiles!`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Bulk start error: ' + err.message, 'error');
  }
}

async function executeBulkStop() {
  const ids = Array.from(selectedProfileIds);
  if (ids.length === 0) return;

  try {
    const res = await fetch('/api/profiles/bulk-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const data = await res.json();
    showToast(`Stopped ${data.count} running profiles`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Bulk stop error: ' + err.message, 'error');
  }
}

async function executeBulkRandomizeFp() {
  const ids = Array.from(selectedProfileIds);
  if (ids.length === 0) return;

  try {
    const res = await fetch('/api/profiles/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'randomize_fingerprint' })
    });
    const data = await res.json();
    showToast(`Generated new fingerprints for ${data.count} profiles!`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Error randomizing fingerprints', 'error');
  }
}

async function executeBulkDelete() {
  const ids = Array.from(selectedProfileIds);
  if (ids.length === 0) return;

  if (!window.confirm(`Are you sure you want to delete ${ids.length} selected profiles? This action cannot be undone.`)) {
    return;
  }

  try {
    const res = await fetch('/api/profiles/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const data = await res.json();
    selectedProfileIds.clear();
    showToast(`Deleted ${data.count} profiles`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Error deleting profiles: ' + err.message, 'error');
  }
}

// -------------------------------------------------------------
// MODALS MANAGEMENT
// -------------------------------------------------------------
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('show');
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = 'none';
  }
}

function setupModalDismissals() {
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal(btn.dataset.close);
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.classList.remove('show');
        backdrop.style.display = 'none';
      }
    });
  });
}

// Single Profile Create / Edit Modal
function openCreateModal() {
  editingProfileId = null;
  document.getElementById('modal-title').textContent = 'Create New Browser Profile';
  
  document.getElementById('p-name').value = `Stealth Profile #${profiles.length + 1}`;
  document.getElementById('p-os').value = 'Windows 11';
  document.getElementById('p-engine').value = 'orbita';
  document.getElementById('p-tags').value = '';
  document.getElementById('p-notes').value = '';

  const noProxyRadio = document.querySelector('input[name="proxy-type"][value="none"]');
  if (noProxyRadio) noProxyRadio.checked = true;
  document.getElementById('proxy-details-box').style.display = 'none';
  document.getElementById('px-host').value = '';
  document.getElementById('px-port').value = '';
  document.getElementById('px-user').value = '';
  document.getElementById('px-pass').value = '';
  document.getElementById('proxy-check-status').textContent = '';

  const smartInput = document.getElementById('px-smart-input');
  if (smartInput) smartInput.value = '';
  const smartAlert = document.getElementById('smart-paste-alert');
  if (smartAlert) {
    smartAlert.style.display = 'none';
    smartAlert.textContent = '';
  }

  generateNewFingerprint('Windows 11');
  switchTab('tab-general');
  openModal('profile-modal');
}

function openEditModal(id) {
  const p = profiles.find(item => item.id === id);
  if (!p) return;

  editingProfileId = id;
  document.getElementById('modal-title').textContent = `Edit Profile: ${p.name}`;
  
  document.getElementById('p-name').value = p.name;
  document.getElementById('p-os').value = p.fingerprint?.os || 'Windows 11';
  document.getElementById('p-engine').value = p.engine || 'orbita';
  document.getElementById('p-tags').value = (p.tags || []).join(', ');
  document.getElementById('p-notes').value = p.notes || '';

  const mode = p.proxy?.mode || 'none';
  const radio = document.querySelector(`input[name="proxy-type"][value="${mode}"]`);
  if (radio) radio.checked = true;
  document.getElementById('proxy-details-box').style.display = (mode === 'none') ? 'none' : 'block';
  document.getElementById('px-host').value = p.proxy?.host || '';
  document.getElementById('px-port').value = p.proxy?.port || '';
  document.getElementById('px-user').value = p.proxy?.username || '';
  document.getElementById('px-pass').value = p.proxy?.password || '';
  document.getElementById('proxy-check-status').textContent = '';

  const smartInput = document.getElementById('px-smart-input');
  const smartAlert = document.getElementById('smart-paste-alert');
  if (smartAlert) smartAlert.style.display = 'none';
  if (smartInput) {
    if (p.proxy && p.proxy.host && p.proxy.port) {
      const auth = p.proxy.username ? `${p.proxy.username}:${p.proxy.password}@` : '';
      smartInput.value = `${p.proxy.mode === 'socks5' ? 'socks5://' : ''}${auth}${p.proxy.host}:${p.proxy.port}`;
    } else {
      smartInput.value = '';
    }
  }

  currentFingerprint = p.fingerprint || {};
  renderFingerprintFields(currentFingerprint);

  switchTab('tab-general');
  openModal('profile-modal');
}

async function generateNewFingerprint(os = 'Windows 11') {
  try {
    const res = await fetch(`/api/generate-fingerprint?os=${encodeURIComponent(os)}`);
    currentFingerprint = await res.json();
    renderFingerprintFields(currentFingerprint);
  } catch (err) {
    console.error('Failed to generate fingerprint:', err);
  }
}

function renderFingerprintFields(fp) {
  document.getElementById('fp-canvas').checked = fp.canvasNoise !== false;
  document.getElementById('fp-webgl').checked = fp.webglNoise !== false;
  document.getElementById('fp-audio').checked = fp.audioNoise !== false;
  document.getElementById('fp-webrtc').checked = fp.webrtcMode !== 'real';
  document.getElementById('fp-res').value = fp.screenResolution || '1920x1080';
  document.getElementById('fp-cores').value = (fp.cpuCores || 8).toString();
  document.getElementById('fp-ram').value = (fp.ramGb || 16).toString();
  document.getElementById('fp-gpu').value = `${fp.webglVendor || 'Google Inc.'} / ${fp.webglRenderer || 'ANGLE NVIDIA'}`;
  document.getElementById('fp-ua').value = fp.userAgent || '';
}

async function saveProfile() {
  console.log('saveProfile invoked');
  const nameInput = document.getElementById('p-name');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    showToast('Profile name is required!', 'error');
    return;
  }

  const proxyRadio = document.querySelector('input[name="proxy-type"]:checked');
  const proxyType = proxyRadio ? proxyRadio.value : 'none';
  const tagsInput = document.getElementById('p-tags');
  const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean) : [];

  const engineSelect = document.getElementById('p-engine');
  const notesInput = document.getElementById('p-notes');
  const hostInput = document.getElementById('px-host');
  const portInput = document.getElementById('px-port');
  const userInput = document.getElementById('px-user');
  const passInput = document.getElementById('px-pass');
  const osSelect = document.getElementById('p-os');
  const canvasCheck = document.getElementById('fp-canvas');
  const webglCheck = document.getElementById('fp-webgl');
  const audioCheck = document.getElementById('fp-audio');
  const webrtcCheck = document.getElementById('fp-webrtc');
  const resSelect = document.getElementById('fp-res');
  const coresSelect = document.getElementById('fp-cores');
  const ramSelect = document.getElementById('fp-ram');
  const uaInput = document.getElementById('fp-ua');

  const payload = {
    name,
    engine: engineSelect ? engineSelect.value : 'camoufox',
    tags,
    notes: notesInput ? notesInput.value.trim() : '',
    proxy: {
      mode: proxyType,
      host: hostInput ? hostInput.value.trim() : '',
      port: portInput ? portInput.value.trim() : '',
      username: userInput ? userInput.value.trim() : '',
      password: passInput ? passInput.value.trim() : ''
    },
    fingerprint: {
      ...(currentFingerprint || {}),
      os: osSelect ? osSelect.value : 'Windows 11',
      canvasNoise: canvasCheck ? canvasCheck.checked : true,
      webglNoise: webglCheck ? webglCheck.checked : true,
      audioNoise: audioCheck ? audioCheck.checked : true,
      webrtcMode: (webrtcCheck && webrtcCheck.checked) ? 'altered' : 'real',
      screenResolution: resSelect ? resSelect.value : '1920x1080',
      cpuCores: coresSelect ? parseInt(coresSelect.value, 10) : 8,
      ramGb: ramSelect ? parseInt(ramSelect.value, 10) : 16,
      userAgent: uaInput ? uaInput.value.trim() : ''
    }
  };

  try {
    if (editingProfileId) {
      const res = await fetch(`/api/profiles/${editingProfileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Update failed with status ' + res.status);
      showToast(`Profile "${name}" updated`, 'success');
    } else {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Create failed with status ' + res.status);
      showToast(`Created profile "${name}"!`, 'success');
    }
    closeModal('profile-modal');
    editingProfileId = null;
    await loadProfiles(false);
  } catch (err) {
    console.error('saveProfile error:', err);
    showToast('Failed to save profile: ' + err.message, 'error');
  }
}

// Bulk Add Execution
async function executeBulkCreate() {
  const count = parseInt(document.getElementById('bulk-count').value, 10) || 5;
  const baseName = document.getElementById('bulk-basename').value.trim() || 'Profile';
  const os = document.getElementById('bulk-os').value;
  const engine = document.getElementById('bulk-engine').value || 'orbita';
  const tags = document.getElementById('bulk-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const proxiesText = document.getElementById('bulk-proxies-text').value.trim();

  // Parse proxies list using Smart Proxy Parser
  const proxiesList = [];
  if (proxiesText) {
    const lines = proxiesText.split('\n');
    lines.forEach(line => {
      const parsed = parseProxyString(line);
      if (parsed && parsed.host && parsed.port) {
        proxiesList.push(parsed);
      }
    });
  }

  showToast(`Generating ${count} unique anti-detect profiles...`, 'info', 2500);

  try {
    const res = await fetch('/api/profiles/bulk-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, baseName, os, engine, tags, proxiesList })
    });
    const data = await res.json();
    closeModal('bulk-modal');
    showToast(`Created ${data.count} new profiles with unique fingerprints!`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Bulk create failed: ' + err.message, 'error');
  }
}

// Bulk Proxy Execution
async function executeBulkProxy() {
  const ids = Array.from(selectedProfileIds);
  if (ids.length === 0) return;

  const mode = document.getElementById('bulk-px-mode').value;
  const host = document.getElementById('bulk-px-host').value.trim();
  const port = document.getElementById('bulk-px-port').value.trim();
  const username = document.getElementById('bulk-px-user').value.trim();
  const password = document.getElementById('bulk-px-pass').value.trim();

  const proxy = { mode, host, port, username, password };

  try {
    const res = await fetch('/api/profiles/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'set_proxy', data: { proxy } })
    });
    const data = await res.json();
    closeModal('bulk-proxy-modal');
    showToast(`Proxy applied to ${data.count} profiles!`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Failed to apply proxy', 'error');
  }
}

// Bulk Tag Execution
async function executeBulkTag() {
  const ids = Array.from(selectedProfileIds);
  if (ids.length === 0) return;

  const tag = document.getElementById('bulk-tag-input').value.trim();
  if (!tag) {
    showToast('Tag name required', 'error');
    return;
  }

  try {
    const res = await fetch('/api/profiles/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'add_tag', data: { tag } })
    });
    const data = await res.json();
    closeModal('bulk-tag-modal');
    showToast(`Added tag "${tag}" to ${data.count} profiles!`, 'success');
    await loadProfiles(false);
  } catch (err) {
    showToast('Failed to add tag', 'error');
  }
}

// Tab Switching Helper
function switchTab(targetId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === targetId);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === targetId);
  });
}

// -------------------------------------------------------------
// VIEW SWITCHING (Sidebar Navigation)
// -------------------------------------------------------------
function switchView(viewName) {
  currentView = viewName;

  // 1. Update navigation items active state
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // 2. Hide all view panes, show target
  const views = ['profiles', 'proxies', 'fingerprints', 'engines'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) {
      if (v === viewName) {
        el.classList.remove('hidden');
        el.style.display = 'flex';
      } else {
        el.classList.add('hidden');
        el.style.display = 'none';
      }
    }
  });

  // 3. Update topbar title & actions
  const titleEl = document.querySelector('.page-title');
  const bulkBtn = document.getElementById('btn-open-bulk-modal');
  const newBtn = document.getElementById('btn-create-profile');

  if (viewName === 'profiles') {
    if (titleEl) titleEl.textContent = 'Browser Profiles';
    if (bulkBtn) bulkBtn.style.display = '';
    if (newBtn) newBtn.style.display = '';
  } else if (viewName === 'proxies') {
    if (titleEl) titleEl.textContent = 'Proxy Manager';
    if (bulkBtn) bulkBtn.style.display = 'none';
    if (newBtn) newBtn.style.display = '';
    renderProxyManager();
  } else if (viewName === 'fingerprints') {
    if (titleEl) titleEl.textContent = 'Fingerprints & Hardware Emulation';
    if (bulkBtn) bulkBtn.style.display = 'none';
    if (newBtn) newBtn.style.display = 'none';
  } else if (viewName === 'engines') {
    if (titleEl) titleEl.textContent = 'Installed Browser Engines';
    if (bulkBtn) bulkBtn.style.display = 'none';
    if (newBtn) newBtn.style.display = 'none';
    renderEnginesView();
  }
}

// -------------------------------------------------------------
// SMART PROXY AUTO-DETECTOR
// -------------------------------------------------------------
function applySmartProxyToForm(raw, context = 'single') {
  if (!raw || typeof raw !== 'string') return;
  const parsed = parseProxyString(raw);
  if (!parsed || !parsed.host) return;

  if (context === 'single') {
    const proto = parsed.mode === 'socks5' ? 'socks5' : (parsed.mode === 'socks4' ? 'socks5' : 'http');
    const radio = document.querySelector(`input[name="proxy-type"][value="${proto}"]`);
    if (radio) radio.checked = true;

    const box = document.getElementById('proxy-details-box');
    if (box) box.style.display = 'block';

    document.getElementById('px-host').value = parsed.host;
    document.getElementById('px-port').value = parsed.port || '';
    document.getElementById('px-user').value = parsed.username || '';
    document.getElementById('px-pass').value = parsed.password || '';

    const alertEl = document.getElementById('smart-paste-alert');
    if (alertEl) {
      alertEl.className = 'smart-paste-alert success';
      alertEl.style.display = 'flex';
      const authInfo = parsed.username ? `· Auth: <strong>${escapeHtml(parsed.username)}</strong>` : '· Direct (No Auth)';
      alertEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> <span>Detected <strong>${proto.toUpperCase()}</strong>: ${escapeHtml(parsed.host)}:${escapeHtml(parsed.port || '')} ${authInfo}</span>`;
    }

    if (parsed.host && parsed.port) {
      document.getElementById('btn-check-proxy').click();
    }
  } else if (context === 'bulk') {
    const proto = parsed.mode === 'socks5' ? 'socks5' : 'http';
    const select = document.getElementById('bulk-px-mode');
    if (select) select.value = proto;
    document.getElementById('bulk-px-host').value = parsed.host;
    document.getElementById('bulk-px-port').value = parsed.port || '';
    document.getElementById('bulk-px-user').value = parsed.username || '';
    document.getElementById('bulk-px-pass').value = parsed.password || '';
  } else if (context === 'manager') {
    const details = document.getElementById('mgr-proxy-details');
    if (details) details.style.display = 'block';
    document.getElementById('mgr-px-proto').value = parsed.mode.toUpperCase();
    document.getElementById('mgr-px-host').value = parsed.host;
    document.getElementById('mgr-px-port').value = parsed.port || '';
    document.getElementById('mgr-px-auth').value = parsed.username ? `${parsed.username} / ••••` : 'None';
  }
}

// -------------------------------------------------------------
// PROXY MANAGER VIEW RENDERER
// -------------------------------------------------------------
function renderProxyManager() {
  const tbody = document.getElementById('proxy-manager-table-body');
  const countLabel = document.getElementById('proxies-count-label');
  if (!tbody) return;

  const proxyMap = new Map();

  profiles.forEach(p => {
    if (p.proxy && p.proxy.mode !== 'none' && p.proxy.host && p.proxy.port) {
      const key = `${p.proxy.mode}://${p.proxy.host}:${p.proxy.port}`;
      if (!proxyMap.has(key)) {
        proxyMap.set(key, {
          proxy: p.proxy,
          profiles: []
        });
      }
      proxyMap.get(key).profiles.push({ id: p.id, name: p.name });
    }
  });

  const list = Array.from(proxyMap.values());
  if (countLabel) countLabel.textContent = `${list.length} Unique Proxies Active`;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-8 text-muted">
          <i class="fa-solid fa-network-wired fa-2x mb-2" style="opacity: 0.3;"></i>
          <p>No proxies configured yet.</p>
          <p class="text-xs text-muted">Use the Smart Tester above or add proxies to your profiles.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map(item => {
    const px = item.proxy;
    const hasAuth = Boolean(px.username && px.password);
    const profileBadges = item.profiles.map(pr => `
      <span class="tag-chip" style="cursor: pointer;" onclick="openEditModal('${pr.id}')" title="Click to edit profile">
        <i class="fa-solid fa-folder"></i> ${escapeHtml(pr.name)}
      </span>
    `).join(' ');

    const rowId = `mgr-row-${px.host.replace(/[^a-zA-Z0-9]/g, '_')}-${px.port}`;

    return `
      <tr id="${rowId}">
        <td>
          <div class="profile-name-cell">
            <i class="fa-solid fa-server text-green"></i>
            <div>
              <div class="profile-name text-code font-bold">${escapeHtml(px.host)}:${escapeHtml(px.port)}</div>
              <div class="text-xs text-muted" id="status-${rowId}">Ready to test</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge ${px.mode === 'socks5' ? 'badge-blue' : 'badge-green'}">
            ${px.mode ? px.mode.toUpperCase() : 'HTTP'}
          </span>
        </td>
        <td>
          ${hasAuth ? `<span class="text-green text-xs"><i class="fa-solid fa-lock"></i> ${escapeHtml(px.username)}</span>` : '<span class="text-muted text-xs">No Auth</span>'}
        </td>
        <td>
          <div class="profile-tags" style="gap: 4px;">
            ${profileBadges}
          </div>
        </td>
        <td>
          <span class="status-pill active" title="WebRTC STUN forced through proxy"><i class="fa-solid fa-shield-halved"></i> Enabled</span>
        </td>
        <td class="text-right">
          <button class="btn btn-sm btn-secondary" onclick="testProxyFromRow('${escapeHtml(px.host)}', '${escapeHtml(px.port)}', '${escapeHtml(px.mode)}', '${escapeHtml(px.username || '')}', '${escapeHtml(px.password || '')}', 'status-${rowId}')">
            <i class="fa-solid fa-bolt"></i> Ping Test
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function testProxyFromRow(host, port, mode, username, password, targetStatusId) {
  const statusEl = document.getElementById(targetStatusId);
  if (statusEl) {
    statusEl.innerHTML = '<span class="text-muted"><i class="fa-solid fa-spinner fa-spin"></i> Checking latency...</span>';
  }

  try {
    const res = await fetch('/api/check-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, mode, username, password })
    });
    const data = await res.json();
    if (data.status === 'online') {
      if (statusEl) statusEl.innerHTML = `<span class="text-green"><i class="fa-solid fa-check"></i> Online (${data.pingMs}ms) · IP: ${data.ip || 'OK'}</span>`;
      showToast(`Proxy ${host}:${port} online (${data.pingMs}ms)`, 'success');
    } else {
      if (statusEl) statusEl.innerHTML = `<span class="text-danger"><i class="fa-solid fa-xmark"></i> ${data.error || 'Failed'}</span>`;
      showToast(`Proxy offline: ${data.error || 'Failed'}`, 'error');
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation"></i> Error</span>`;
  }
}

// -------------------------------------------------------------
// ENGINES VIEW RENDERER
// -------------------------------------------------------------
function renderEnginesView() {
  const container = document.getElementById('engines-cards-container');
  const countLabel = document.getElementById('engines-count-label');
  if (!container) return;

  const engines = systemInfo?.engines || [];
  if (countLabel) countLabel.textContent = `${engines.length} Engine(s) Ready`;

  let html = '';

  engines.forEach(eng => {
    const isOrbita = eng.id === 'orbita';
    const isChrome = eng.id === 'chrome';
    const isEdge = eng.id === 'edge';
    const isCamoufox = eng.id === 'camoufox';

    let icon = 'fa-solid fa-shield-halved';
    let borderColor = 'var(--primary)';
    let desc = '';

    if (isOrbita) {
      icon = 'fa-solid fa-shield-halved';
      borderColor = 'var(--primary)';
      desc = 'Native GoLogin Orbita Chromium Engine. Features kernel-level hardware spoofing, Skia canvas noise, isolated user-data-dir, and automation masking without navigator.webdriver flags.';
    } else if (isChrome) {
      icon = 'fa-brands fa-chrome';
      borderColor = '#f59e0b';
      desc = 'Official Google Chrome binary running with stealth flags (--disable-blink-features=AutomationControlled), isolated user-data-dir, and WebRTC proxy tunnel protection.';
    } else if (isEdge) {
      icon = 'fa-brands fa-edge';
      borderColor = '#38bdf8';
      desc = 'Microsoft Edge running with stealth anti-automation parameters, dedicated storage profiles, and encrypted proxy forwarding.';
    } else if (isCamoufox) {
      icon = 'fa-solid fa-shield-cat';
      borderColor = '#a855f7';
      desc = 'Firefox Gecko-based alternative engine. C++ patched rasterizer with user.js profile injection.';
    }

    html += `
      <div class="info-card" style="border-left: 4px solid ${borderColor};">
        <div class="info-card-header">
          <div class="info-card-title" style="color: ${borderColor};">
            <i class="${icon}"></i>
            ${escapeHtml(eng.name)}
          </div>
          <span class="status-pill ${eng.isDefault ? 'active' : 'ready'}">${eng.isDefault ? 'DEFAULT ENGINE' : 'AVAILABLE'}</span>
        </div>
        <div class="info-card-desc">
          ${desc}
        </div>
        <div class="info-card-meta">
          <strong>Binary Path:</strong> <code>${escapeHtml(eng.path)}</code>
        </div>
        <div class="flex-row gap-2 mt-2">
          <button class="btn btn-sm btn-secondary" onclick="testFirstProfileWithEngine('${eng.id}')">
            <i class="fa-solid fa-play"></i> Launch Test Window
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function testFirstProfileWithUrl(url) {
  if (profiles.length === 0) {
    showToast('Please create at least one profile first!', 'error');
    openCreateModal();
    return;
  }
  const prof = profiles.find(p => !p.isRunning) || profiles[0];
  showToast(`Launching ${prof.name} on ${url}...`, 'info');
  try {
    const res = await fetch(`/api/profiles/${prof.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Launched! Engine: ${data.engine}`, 'success');
      loadProfiles(false);
    } else {
      showToast(data.message || data.error, 'error');
    }
  } catch (err) {
    showToast('Launch failed: ' + err.message, 'error');
  }
}

async function testFirstProfileWithEngine(engineId) {
  if (profiles.length === 0) {
    showToast('Please create at least one profile first!', 'error');
    openCreateModal();
    return;
  }
  const prof = profiles[0];
  showToast(`Launching ${prof.name} with ${engineId}...`, 'info');
  try {
    await fetch(`/api/profiles/${prof.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: engineId })
    });
    await fetch(`/api/profiles/${prof.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://browserleaks.com' })
    });
    loadProfiles(false);
  } catch (err) {
    showToast('Launch failed: ' + err.message, 'error');
  }
}

// -------------------------------------------------------------
// EVENT LISTENERS
// -------------------------------------------------------------
function setupEventListeners() {
  // Modal Open Buttons
  document.getElementById('btn-create-profile').addEventListener('click', openCreateModal);
  document.getElementById('btn-open-bulk-modal').addEventListener('click', () => openModal('bulk-modal'));
  document.getElementById('btn-bulk-proxy-modal').addEventListener('click', () => openModal('bulk-proxy-modal'));
  document.getElementById('btn-bulk-tag-modal').addEventListener('click', () => openModal('bulk-tag-modal'));

  // Execution Buttons
  document.getElementById('modal-save-btn').addEventListener('click', saveProfile);
  document.getElementById('btn-execute-bulk-create').addEventListener('click', executeBulkCreate);
  document.getElementById('btn-execute-bulk-proxy').addEventListener('click', executeBulkProxy);
  document.getElementById('btn-execute-bulk-tag').addEventListener('click', executeBulkTag);

  // Bulk Actions
  document.getElementById('btn-bulk-start').addEventListener('click', executeBulkStart);
  document.getElementById('btn-bulk-stop').addEventListener('click', executeBulkStop);
  document.getElementById('btn-bulk-fp').addEventListener('click', executeBulkRandomizeFp);
  document.getElementById('btn-bulk-delete').addEventListener('click', executeBulkDelete);
  document.getElementById('btn-bulk-deselect').addEventListener('click', deselectAll);

  // Search & Filters
  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('clear-search-btn');

  searchInput.addEventListener('input', () => {
    clearBtn.style.display = searchInput.value ? 'block' : 'none';
    renderProfilesTable();
    if (currentView === 'proxies') {
      renderProxyManager();
    }
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    renderProfilesTable();
    if (currentView === 'proxies') {
      renderProxyManager();
    }
  });

  document.getElementById('filter-status').addEventListener('change', renderProfilesTable);
  document.getElementById('filter-engine').addEventListener('change', renderProfilesTable);
  document.getElementById('btn-refresh').addEventListener('click', () => {
    showToast('Refreshing profiles...', 'info', 1000);
    loadProfiles();
  });

  // Table Checkboxes Delegated Listener
  const tbodyEl = document.getElementById('profiles-table-body');
  tbodyEl.addEventListener('change', handleRowCheckboxClick);
  tbodyEl.addEventListener('click', (e) => {
    if (e.target && e.target.matches && e.target.matches('.profile-row-checkbox')) {
      handleRowCheckboxClick(e);
    }
  });
  document.getElementById('select-all-checkbox').addEventListener('change', handleSelectAll);

  // Modal Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(btn.dataset.tab);
    });
  });

  // Proxy Protocol Radio Changes
  document.querySelectorAll('input[name="proxy-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isNone = radio.value === 'none';
      document.getElementById('proxy-details-box').style.display = isNone ? 'none' : 'block';
    });
  });

  // Randomize Fingerprint
  document.getElementById('btn-randomize-fp').addEventListener('click', () => {
    const os = document.getElementById('p-os').value;
    generateNewFingerprint(os);
    showToast('Generated fresh C++ hardware profile', 'success', 2000);
  });

  document.getElementById('p-os').addEventListener('change', () => {
    generateNewFingerprint(document.getElementById('p-os').value);
  });

  // Proxy Test Connection
  document.getElementById('btn-check-proxy').addEventListener('click', async () => {
    const statusMsg = document.getElementById('proxy-check-status');
    const host = document.getElementById('px-host').value.trim();
    const port = document.getElementById('px-port').value.trim();

    if (!host || !port) {
      statusMsg.innerHTML = '<span style="color: var(--danger);">Host and port are required</span>';
      return;
    }

    statusMsg.innerHTML = '<span style="color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Checking latency...</span>';

    try {
      const res = await fetch('/api/check-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          port,
          mode: document.querySelector('input[name="proxy-type"]:checked').value,
          username: document.getElementById('px-user').value.trim(),
          password: document.getElementById('px-pass').value.trim()
        })
      });
      const data = await res.json();
      if (data.status === 'online') {
        statusMsg.innerHTML = `<span style="color: var(--primary);">✓ Online (${data.pingMs}ms) · IP: ${data.ip || 'OK'}</span>`;
      } else {
        statusMsg.innerHTML = `<span style="color: var(--danger);">✗ Connection failed: ${data.error || 'Timeout'}</span>`;
      }
    } catch (err) {
      statusMsg.innerHTML = `<span style="color: var(--danger);">✗ Request error: ${err.message}</span>`;
    }
  });

  // Sidebar Navigation Items
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(item.dataset.view);
    });
  });

  // Smart Proxy Auto-Detector on Single Profile Modal
  const smartInput = document.getElementById('px-smart-input');
  const clearSmartBtn = document.getElementById('btn-smart-paste-clear');
  if (smartInput) {
    smartInput.addEventListener('input', () => {
      applySmartProxyToForm(smartInput.value, 'single');
    });
    smartInput.addEventListener('paste', () => {
      setTimeout(() => applySmartProxyToForm(smartInput.value, 'single'), 20);
    });
  }
  if (clearSmartBtn) {
    clearSmartBtn.addEventListener('click', () => {
      smartInput.value = '';
      const alertEl = document.getElementById('smart-paste-alert');
      if (alertEl) alertEl.style.display = 'none';
    });
  }

  // Also smart-paste if user pastes whole proxy line directly into Host field
  const pxHost = document.getElementById('px-host');
  if (pxHost) {
    pxHost.addEventListener('paste', (e) => {
      const pasted = (e.clipboardData || window.clipboardData)?.getData('text');
      if (pasted && (pasted.includes(':') || pasted.includes('@') || pasted.includes(' '))) {
        e.preventDefault();
        applySmartProxyToForm(pasted, 'single');
      }
    });
  }

  // Smart Proxy Auto-Detector on Bulk Proxy Modal
  const bulkSmartInput = document.getElementById('bulk-px-smart-paste');
  if (bulkSmartInput) {
    bulkSmartInput.addEventListener('input', () => {
      applySmartProxyToForm(bulkSmartInput.value, 'bulk');
    });
    bulkSmartInput.addEventListener('paste', () => {
      setTimeout(() => applySmartProxyToForm(bulkSmartInput.value, 'bulk'), 20);
    });
  }

  // Smart Proxy in Proxy Manager View
  const mgrInput = document.getElementById('mgr-proxy-input');
  const mgrTestBtn = document.getElementById('btn-mgr-test-proxy');
  const mgrClearBtn = document.getElementById('btn-mgr-clear-proxy');
  const mgrCreateBtn = document.getElementById('btn-create-profile-with-proxy');

  if (mgrInput) {
    mgrInput.addEventListener('input', () => {
      applySmartProxyToForm(mgrInput.value, 'manager');
    });
    mgrInput.addEventListener('paste', () => {
      setTimeout(() => applySmartProxyToForm(mgrInput.value, 'manager'), 20);
    });
  }
  if (mgrClearBtn) {
    mgrClearBtn.addEventListener('click', () => {
      mgrInput.value = '';
      const details = document.getElementById('mgr-proxy-details');
      if (details) details.style.display = 'none';
      const statusEl = document.getElementById('mgr-proxy-status');
      if (statusEl) statusEl.innerHTML = '';
    });
  }
  if (mgrTestBtn) {
    mgrTestBtn.addEventListener('click', async () => {
      const raw = mgrInput.value.trim();
      const parsed = parseProxyString(raw);
      if (!parsed || !parsed.host || !parsed.port) {
        showToast('Please paste a valid proxy string first (host:port)', 'error');
        return;
      }
      const statusEl = document.getElementById('mgr-proxy-status');
      statusEl.innerHTML = '<span class="text-muted"><i class="fa-solid fa-spinner fa-spin"></i> Testing latency...</span>';
      try {
        const res = await fetch('/api/check-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed)
        });
        const data = await res.json();
        if (data.status === 'online') {
          statusEl.innerHTML = `<span class="text-green"><i class="fa-solid fa-circle-check"></i> <strong>ONLINE</strong> (${data.pingMs}ms latency) · Detected Outbound IP: <strong>${data.ip || 'OK'}</strong> · Zero WebRTC leak</span>`;
          showToast(`Proxy online (${data.pingMs}ms)!`, 'success');
        } else {
          statusEl.innerHTML = `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation"></i> <strong>OFFLINE</strong>: ${data.error || 'Connection failed'}</span>`;
          showToast(`Proxy offline: ${data.error || 'Failed'}`, 'error');
        }
      } catch (err) {
        statusEl.innerHTML = `<span class="text-danger">Request error: ${err.message}</span>`;
      }
    });
  }
  if (mgrCreateBtn) {
    mgrCreateBtn.addEventListener('click', () => {
      const raw = mgrInput.value.trim();
      const parsed = parseProxyString(raw);
      openCreateModal();
      if (parsed && parsed.host) {
        switchTab('tab-proxy');
        applySmartProxyToForm(raw, 'single');
      }
    });
  }
}

// Global scope bindings for inline action buttons
window.startSingleProfile = startSingleProfile;
window.stopSingleProfile = stopSingleProfile;
window.cloneSingleProfile = cloneSingleProfile;
window.deleteSingleProfile = deleteSingleProfile;
window.openProfileFolder = openProfileFolder;
window.openEditModal = openEditModal;
window.copyToClipboard = copyToClipboard;
window.switchView = switchView;
window.testProxyFromRow = testProxyFromRow;
window.testFirstProfileWithUrl = testFirstProfileWithUrl;
window.testFirstProfileWithEngine = testFirstProfileWithEngine;

// Safe Init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
