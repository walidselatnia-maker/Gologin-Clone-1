const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const https = require('https');
const proxyChain = require('proxy-chain');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors());
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles_data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_FILE)) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify([], null, 2));
}

// Running browser processes map: profileId -> { proc, startTime, anonymizedUrl }
const RUNNING_PROCESSES = new Map();
const ANONYMIZED_PROXIES = new Map(); // profileId -> anonymizedProxyUrl

async function setupProxyForProfile(profile) {
  const proxy = profile.proxy;
  if (!proxy || proxy.mode === 'none' || !proxy.host || !proxy.port) {
    return null;
  }

  const mode = proxy.mode === 'socks5' ? 'socks5' : (proxy.mode === 'socks4' ? 'socks4' : 'http');
  const hasAuth = Boolean(proxy.username && proxy.password);

  if (hasAuth) {
    try {
      const rawUrl = `${mode}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
      const anonymizedUrl = await proxyChain.anonymizeProxy(rawUrl);
      ANONYMIZED_PROXIES.set(profile.id, anonymizedUrl);
      const parsed = new URL(anonymizedUrl);
      return {
        mode: 'http',
        host: parsed.hostname,
        port: parsed.port,
        isAnonymized: true,
        anonymizedUrl
      };
    } catch (err) {
      console.error(`Failed to anonymize proxy for profile ${profile.id}:`, err);
      // Fallback to direct without auth forwarder
      return {
        mode,
        host: proxy.host,
        port: proxy.port,
        isAnonymized: false
      };
    }
  }

  return {
    mode,
    host: proxy.host,
    port: proxy.port,
    isAnonymized: false
  };
}

async function cleanupProxyForProfile(profileId) {
  if (ANONYMIZED_PROXIES.has(profileId)) {
    const url = ANONYMIZED_PROXIES.get(profileId);
    ANONYMIZED_PROXIES.delete(profileId);
    try {
      await proxyChain.closeAnonymizedProxy(url, true);
    } catch (e) {
      console.error(`Error closing proxy forwarder for ${profileId}:`, e.message);
    }
  }
}

function readProfiles() {
  try {
    const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

// Engine Detection
function findAvailableEngines() {
  const engines = [];

  // 1. Primary Engine: GoLogin Orbita Native Chromium (DRM-free versions 146, 145, 144, 142, 132)
  const orbitaBase = path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.gologin', 'browser');
  const candidateOrbita = [
    'orbita-browser-146',
    'orbita-browser-145',
    'orbita-browser-144',
    'orbita-browser-142',
    'orbita-browser-132'
  ];
  let foundOrbita = null;
  if (fs.existsSync(orbitaBase)) {
    for (const c of candidateOrbita) {
      const full = path.join(orbitaBase, c, 'chrome.exe');
      if (fs.existsSync(full)) {
        foundOrbita = { path: full, version: c.replace('orbita-browser-', '') };
        break;
      }
    }
  }

  if (foundOrbita) {
    engines.push({
      id: 'orbita',
      name: `Orbita Engine (Native GoLogin Chromium v${foundOrbita.version})`,
      path: foundOrbita.path,
      type: 'chromium',
      isDefault: true
    });
  }

  // 2. Google Chrome (Stealth Profile)
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  for (const cp of chromePaths) {
    if (fs.existsSync(cp)) {
      engines.push({
        id: 'chrome',
        name: 'Google Chrome (Stealth Profile)',
        path: cp,
        type: 'chromium',
        isDefault: engines.length === 0
      });
      break;
    }
  }

  // 3. Microsoft Edge (Stealth Profile)
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const ep of edgePaths) {
    if (fs.existsSync(ep)) {
      engines.push({
        id: 'edge',
        name: 'Microsoft Edge (Stealth Profile)',
        path: ep,
        type: 'chromium',
        isDefault: engines.length === 0
      });
      break;
    }
  }

  // 4. Camoufox (Optional Firefox-based engine)
  const explicitCamoufoxPath = 'C:\\Users\\Administrator\\AppData\\Local\\camoufox\\camoufox\\Cache\\browsers\\official\\152.0.4-beta.30-ea52a02f\\camoufox.exe';
  let foundCamoufox = fs.existsSync(explicitCamoufoxPath) ? explicitCamoufoxPath : null;

  if (!foundCamoufox) {
    const camoufoxBase = path.join(process.env.LOCALAPPDATA || '', 'camoufox');
    if (fs.existsSync(camoufoxBase)) {
      try {
        function searchExe(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              const res = searchExe(full);
              if (res) return res;
            } else if (ent.name === 'camoufox.exe') {
              return full;
            }
          }
          return null;
        }
        foundCamoufox = searchExe(camoufoxBase);
      } catch (e) {}
    }
  }

  if (foundCamoufox) {
    engines.push({
      id: 'camoufox',
      name: 'Camoufox (Firefox-based Alternative)',
      path: foundCamoufox,
      type: 'camoufox',
      isDefault: false
    });
  }

  return engines;
}

// Fingerprint Generators
const GPU_PRESETS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' }
];

const RESOLUTIONS = [
  '1920x1080',
  '2560x1440',
  '1680x1050',
  '1536x864',
  '1440x900',
  '1366x768'
];

const USER_AGENTS_WIN = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
];

const USER_AGENTS_MAC = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0'
];

const USER_AGENTS_LINUX = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0'
];

function generateFingerprint(os = 'Windows 11') {
  const gpu = GPU_PRESETS[Math.floor(Math.random() * GPU_PRESETS.length)];
  const res = RESOLUTIONS[Math.floor(Math.random() * RESOLUTIONS.length)];
  const cores = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
  const ram = [8, 16, 32][Math.floor(Math.random() * 3)];
  
  let uas = USER_AGENTS_WIN;
  if (os && os.toLowerCase().includes('mac')) uas = USER_AGENTS_MAC;
  else if (os && os.toLowerCase().includes('linux')) uas = USER_AGENTS_LINUX;
  
  const ua = uas[Math.floor(Math.random() * uas.length)];

  return {
    os,
    userAgent: ua,
    screenResolution: res,
    cpuCores: cores,
    ramGb: ram,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    canvasNoise: true,
    webglNoise: true,
    audioNoise: true,
    webrtcMode: 'altered',
    timezoneMode: 'auto',
    language: 'en-US,en;q=0.9',
    doNotTrack: false
  };
}

// -------------------------------------------------------------
// REST API ROUTES
// -------------------------------------------------------------

// System Info
app.get('/api/system-info', (req, res) => {
  const engines = findAvailableEngines();
  const profiles = readProfiles();
  const running = profiles.filter(p => RUNNING_PROCESSES.has(p.id)).length;
  
  res.json({
    platform: process.platform,
    engines,
    totalProfiles: profiles.length,
    runningCount: running
  });
});

// Generate Fingerprint
app.get('/api/generate-fingerprint', (req, res) => {
  const os = req.query.os || 'Windows 11';
  res.json(generateFingerprint(os));
});

// List Profiles
app.get('/api/profiles', (req, res) => {
  const profiles = readProfiles();
  const enhanced = profiles.map(p => ({
    ...p,
    isRunning: RUNNING_PROCESSES.has(p.id)
  }));
  res.json(enhanced);
});

// Create Single Profile
app.post('/api/profiles', (req, res) => {
  const profiles = readProfiles();
  const id = 'prof_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const targetOs = req.body.os || req.body.fingerprint?.os || 'Windows 11';

  const newProfile = {
    id,
    name: req.body.name || `Profile ${profiles.length + 1}`,
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    notes: req.body.notes || '',
    engine: req.body.engine || 'orbita',
    proxy: req.body.proxy || { mode: 'none', host: '', port: '', username: '', password: '' },
    fingerprint: req.body.fingerprint || generateFingerprint(targetOs),
    createdAt: new Date().toISOString(),
    lastLaunched: null
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  // Initialize directory
  const profDir = path.join(PROFILES_DIR, id);
  if (!fs.existsSync(profDir)) fs.mkdirSync(profDir, { recursive: true });

  res.status(201).json(newProfile);
});

// Bulk Create Profiles
app.post('/api/profiles/bulk-create', (req, res) => {
  const count = parseInt(req.body.count, 10) || 5;
  const baseName = (req.body.baseName || 'Profile').trim();
  const targetOs = req.body.os || 'Windows 11';
  const engine = req.body.engine || 'orbita';
  const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
  const proxiesList = req.body.proxiesList || []; // Array of { host, port, username, password, mode }

  const profiles = readProfiles();
  const created = [];

  for (let i = 1; i <= count; i++) {
    const id = 'prof_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6) + i;
    const name = `${baseName} #${profiles.length + i}`;
    
    // Pick proxy if available
    let proxy = { mode: 'none', host: '', port: '', username: '', password: '' };
    if (proxiesList.length > 0) {
      proxy = proxiesList[(i - 1) % proxiesList.length];
    }

    const p = {
      id,
      name,
      tags: [...tags],
      notes: `Bulk created on ${new Date().toLocaleDateString()}`,
      engine,
      proxy,
      fingerprint: generateFingerprint(targetOs),
      createdAt: new Date().toISOString(),
      lastLaunched: null
    };

    const profDir = path.join(PROFILES_DIR, id);
    if (!fs.existsSync(profDir)) fs.mkdirSync(profDir, { recursive: true });

    profiles.push(p);
    created.push(p);
  }

  saveProfiles(profiles);
  res.status(201).json({ success: true, count: created.length, profiles: created });
});

// Update Profile
app.put('/api/profiles/:id', (req, res) => {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Profile not found' });

  profiles[idx] = { ...profiles[idx], ...req.body };
  saveProfiles(profiles);
  res.json(profiles[idx]);
});

// Delete Profile
app.delete('/api/profiles/:id', async (req, res) => {
  const id = req.params.id;
  await cleanupProxyForProfile(id);
  if (RUNNING_PROCESSES.has(id)) {
    try {
      const procInfo = RUNNING_PROCESSES.get(id);
      procInfo.proc.kill();
      RUNNING_PROCESSES.delete(id);
    } catch (e) {}
  }

  let profiles = readProfiles();
  profiles = profiles.filter(p => p.id !== id);
  saveProfiles(profiles);

  const profDir = path.join(PROFILES_DIR, id);
  if (fs.existsSync(profDir)) {
    try {
      fs.rmSync(profDir, { recursive: true, force: true });
    } catch (e) {}
  }

  res.json({ success: true });
});

// Bulk Delete
app.post('/api/profiles/bulk-delete', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.json({ success: true, count: 0 });

  for (const id of ids) {
    await cleanupProxyForProfile(id);
    if (RUNNING_PROCESSES.has(id)) {
      try {
        const procInfo = RUNNING_PROCESSES.get(id);
        procInfo.proc.kill();
        RUNNING_PROCESSES.delete(id);
      } catch (e) {}
    }

    const profDir = path.join(PROFILES_DIR, id);
    if (fs.existsSync(profDir)) {
      try {
        fs.rmSync(profDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  let profiles = readProfiles();
  profiles = profiles.filter(p => !ids.includes(p.id));
  saveProfiles(profiles);

  res.json({ success: true, count: ids.length });
});

// Bulk Update (Tags, Proxies, or Randomize Fingerprints)
app.post('/api/profiles/bulk-update', (req, res) => {
  const { ids, action, data } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }

  const profiles = readProfiles();
  let updatedCount = 0;

  profiles.forEach(p => {
    if (ids.includes(p.id)) {
      if (action === 'randomize_fingerprint') {
        p.fingerprint = generateFingerprint(p.fingerprint?.os || 'Windows 11');
        updatedCount++;
      } else if (action === 'set_proxy') {
        p.proxy = data.proxy;
        updatedCount++;
      } else if (action === 'add_tag') {
        if (!p.tags) p.tags = [];
        if (!p.tags.includes(data.tag)) p.tags.push(data.tag);
        updatedCount++;
      } else if (action === 'set_engine') {
        p.engine = data.engine;
        updatedCount++;
      }
    }
  });

  saveProfiles(profiles);
  res.json({ success: true, count: updatedCount });
});

// Clone Profile
app.post('/api/profiles/:id/clone', (req, res) => {
  const profiles = readProfiles();
  const source = profiles.find(p => p.id === req.params.id);
  if (!source) return res.status(404).json({ error: 'Source profile not found' });

  const id = 'prof_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const cloned = {
    ...JSON.parse(JSON.stringify(source)),
    id,
    name: source.name + ' (Copy)',
    fingerprint: generateFingerprint(source.fingerprint?.os || 'Windows 11'),
    createdAt: new Date().toISOString(),
    lastLaunched: null
  };

  profiles.push(cloned);
  saveProfiles(profiles);

  const profDir = path.join(PROFILES_DIR, id);
  if (!fs.existsSync(profDir)) fs.mkdirSync(profDir, { recursive: true });

  res.status(201).json(cloned);
});

// Open Profile Folder in Explorer
app.post('/api/profiles/:id/open-folder', (req, res) => {
  const id = req.params.id;
  const profDir = path.join(PROFILES_DIR, id);
  if (!fs.existsSync(profDir)) fs.mkdirSync(profDir, { recursive: true });

  exec(`explorer.exe "${profDir}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Launch Browser for a Profile
async function launchBrowserProcess(profile, targetUrl = 'https://browserleaks.com') {
  const engines = findAvailableEngines();
  let selectedEngine = null;

  if (profile.engine && profile.engine !== 'auto') {
    selectedEngine = engines.find(e => e.id === profile.engine);
  }
  if (!selectedEngine && engines.length > 0) {
    selectedEngine = engines[0];
  }

  if (!selectedEngine) {
    throw new Error('No compatible browser engine found on system.');
  }

  const profileDir = path.join(PROFILES_DIR, profile.id);
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const effectiveProxy = await setupProxyForProfile(profile);
  const args = [];
  const startUrl = targetUrl || 'https://browserleaks.com';

  if (selectedEngine.type === 'camoufox') {
    // Camoufox (Firefox-based native stealth engine)
    // Configure user.js for proxy & WebRTC leak shielding
    let userJs = `// Orbita Anti-Detect Generated Profile Configuration
// Profile ID: ${profile.id}
// Engine: Camoufox C++ Stealth
// Updated: ${new Date().toISOString()}

user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.normandy.enabled", false);
user_pref("app.shield.optoutstudies.enabled", false);
`;

    if (effectiveProxy) {
      if (effectiveProxy.mode === 'socks5') {
        userJs += `
user_pref("network.proxy.type", 1);
user_pref("network.proxy.socks", "${effectiveProxy.host}");
user_pref("network.proxy.socks_port", ${parseInt(effectiveProxy.port, 10)});
user_pref("network.proxy.socks_version", 5);
user_pref("network.proxy.socks_remote_dns", true);
`;
      } else if (effectiveProxy.mode === 'socks4') {
        userJs += `
user_pref("network.proxy.type", 1);
user_pref("network.proxy.socks", "${effectiveProxy.host}");
user_pref("network.proxy.socks_port", ${parseInt(effectiveProxy.port, 10)});
user_pref("network.proxy.socks_version", 4);
user_pref("network.proxy.socks_remote_dns", false);
`;
      } else {
        // HTTP / HTTPS
        userJs += `
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "${effectiveProxy.host}");
user_pref("network.proxy.http_port", ${parseInt(effectiveProxy.port, 10)});
user_pref("network.proxy.ssl", "${effectiveProxy.host}");
user_pref("network.proxy.ssl_port", ${parseInt(effectiveProxy.port, 10)});
user_pref("network.proxy.share_proxy_settings", true);
user_pref("network.proxy.no_proxies_on", "");
`;
      }

      // DNS & WebRTC Leak Protection - Force all DNS & STUN/ICE traffic through proxy
      userJs += `
user_pref("network.proxy.socks_remote_dns", true);
user_pref("media.peerconnection.ice.proxy_only", true);
user_pref("media.peerconnection.ice.default_address_only", true);
user_pref("media.peerconnection.ice.no_host", true);
`;
    } else {
      userJs += `
user_pref("network.proxy.type", 0);
`;
    }

    // Fingerprint spoofing prefs for Camoufox
    if (profile.fingerprint?.userAgent) {
      userJs += `user_pref("general.useragent.override", "${profile.fingerprint.userAgent.replace(/"/g, '\\"')}");\n`;
    }
    if (profile.fingerprint?.language) {
      userJs += `user_pref("intl.accept_languages", "${profile.fingerprint.language}");\n`;
    }

    fs.writeFileSync(path.join(profileDir, 'user.js'), userJs, 'utf8');

    args.push('-profile', profileDir);
    args.push('-no-remote');
    args.push(startUrl);
  } else {
    // Chromium / Chrome / Edge arguments
    args.push(`--user-data-dir=${profileDir}`);
    args.push('--no-first-run');
    args.push('--no-default-browser-check');
    args.push('--disable-blink-features=AutomationControlled');
    args.push('--password-store=basic');

    if (profile.fingerprint?.screenResolution) {
      const [w, h] = profile.fingerprint.screenResolution.split('x');
      if (w && h) args.push(`--window-size=${w},${h}`);
    }

    if (profile.fingerprint?.userAgent) {
      args.push(`--user-agent=${profile.fingerprint.userAgent}`);
    }

    if (effectiveProxy) {
      const proxyType = effectiveProxy.mode === 'socks5' ? 'socks5://' : 'http://';
      args.push(`--proxy-server=${proxyType}${effectiveProxy.host}:${effectiveProxy.port}`);
      // Chromium WebRTC protection
      args.push('--enforce-webrtc-ip-permission-check');
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }

    args.push(startUrl);
  }

  const child = spawn(selectedEngine.path, args, {
    detached: true,
    stdio: 'ignore'
  });

  child.on('exit', () => {
    cleanupProxyForProfile(profile.id);
  });

  child.unref();
  return { proc: child, engine: selectedEngine.name };
}

// Start Profile
app.post('/api/profiles/:id/start', async (req, res) => {
  const id = req.params.id;
  const profiles = readProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  if (RUNNING_PROCESSES.has(id)) {
    return res.json({ message: 'Profile is already running', profileId: id });
  }

  try {
    const { proc, engine } = await launchBrowserProcess(profile, req.body.url);
    RUNNING_PROCESSES.set(id, { proc, startTime: Date.now() });

    proc.on('exit', () => {
      console.log(`Profile ${id} closed.`);
      RUNNING_PROCESSES.delete(id);
      cleanupProxyForProfile(id);
    });

    profile.lastLaunched = new Date().toISOString();
    saveProfiles(profiles);

    res.json({
      success: true,
      profileId: id,
      engine,
      pid: proc.pid
    });
  } catch (err) {
    await cleanupProxyForProfile(id);
    res.status(500).json({ error: err.message });
  }
});

// Stop Profile
app.post('/api/profiles/:id/stop', async (req, res) => {
  const id = req.params.id;
  await cleanupProxyForProfile(id);

  if (!RUNNING_PROCESSES.has(id)) {
    return res.json({ message: 'Profile is not currently running' });
  }

  try {
    const procInfo = RUNNING_PROCESSES.get(id);
    procInfo.proc.kill();
    RUNNING_PROCESSES.delete(id);
    res.json({ success: true, message: 'Browser stopped' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop process' });
  }
});

// Bulk Start Profiles
app.post('/api/profiles/bulk-start', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const profiles = readProfiles();
  const started = [];
  const errors = [];

  for (const id of ids) {
    if (RUNNING_PROCESSES.has(id)) continue;
    const p = profiles.find(item => item.id === id);
    if (!p) continue;

    try {
      const { proc, engine } = await launchBrowserProcess(p);
      RUNNING_PROCESSES.set(id, { proc, startTime: Date.now() });
      proc.on('exit', () => {
        RUNNING_PROCESSES.delete(id);
        cleanupProxyForProfile(id);
      });
      p.lastLaunched = new Date().toISOString();
      started.push(id);
    } catch (err) {
      await cleanupProxyForProfile(id);
      errors.push({ id, error: err.message });
    }
  }

  saveProfiles(profiles);
  res.json({ success: true, started, errors });
});

// Bulk Stop Profiles
app.post('/api/profiles/bulk-stop', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let stoppedCount = 0;

  for (const id of ids) {
    await cleanupProxyForProfile(id);
    if (RUNNING_PROCESSES.has(id)) {
      try {
        const procInfo = RUNNING_PROCESSES.get(id);
        procInfo.proc.kill();
        RUNNING_PROCESSES.delete(id);
        stoppedCount++;
      } catch (e) {}
    }
  }

  res.json({ success: true, count: stoppedCount });
});

// Check Proxy - Real Connection Verification
app.post('/api/check-proxy', async (req, res) => {
  const { host, port, mode = 'http', username, password } = req.body;
  if (!host || !port) {
    return res.status(400).json({ error: 'Host and port are required' });
  }

  const start = Date.now();
  try {
    let agent;
    const authPart = (username && password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    if (mode === 'socks5' || mode === 'socks4') {
      agent = new SocksProxyAgent(`${mode}://${authPart}${host}:${port}`);
    } else {
      agent = new HttpsProxyAgent(`http://${authPart}${host}:${port}`);
    }

    const reqOptions = {
      agent,
      timeout: 9000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      }
    };

    let finished = false;
    const reqClient = https.get('https://api.ipify.org?format=json', reqOptions, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        if (finished) return;
        finished = true;
        try {
          const parsed = JSON.parse(data);
          const pingMs = Date.now() - start;
          res.json({
            status: 'online',
            ip: parsed.ip,
            pingMs,
            proxy: `${host}:${port}`
          });
        } catch (e) {
          res.json({
            status: 'online',
            pingMs: Date.now() - start,
            ip: host,
            proxy: `${host}:${port}`
          });
        }
      });
    });

    reqClient.on('error', (err) => {
      if (finished) return;
      finished = true;
      res.json({ status: 'offline', error: err.message });
    });

    reqClient.on('timeout', () => {
      if (finished) return;
      finished = true;
      reqClient.destroy();
      res.json({ status: 'offline', error: 'Connection timed out (9s)' });
    });
  } catch (err) {
    res.json({ status: 'offline', error: err.message });
  }
});

// Graceful server startup (prevents EADDRINUSE crash if already running)
let server = null;
try {
  server = app.listen(PORT, () => {
    console.log(`Orbita Anti-Detect Manager running at http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Server] Port ${PORT} is already bound by an existing instance.`);
    } else {
      console.error('[Server] Fatal server error:', err);
    }
  });
} catch (e) {
  console.warn(`[Server] Server startup skipped: ${e.message}`);
}
