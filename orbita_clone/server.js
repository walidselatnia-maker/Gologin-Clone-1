const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
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

// Dynamic Version Tracking State for All 3 Engines
const DETECTED_VERSIONS = {
  chrome: { name: 'Google Chrome', installed: null, latest: '157.0.8103.50', major: 157, updateAvailable: false, status: 'checking', path: null },
  orbita: { name: 'GoLogin Orbita Engine', installed: null, latest: '146', major: 146, updateAvailable: false, status: 'checking', path: null },
  camoufox: { name: 'Camoufox (Firefox Anti-Detect)', installed: null, latest: '158.0.1-beta.41', major: 158, updateAvailable: false, status: 'checking', path: null, downloadUrl: null, sizeMb: 1243 }
};

let DOWNLOAD_PROGRESS = { engine: null, percent: 0, status: 'idle', message: '' };

function getLatestChromeMajor() {
  const fromInstalled = DETECTED_VERSIONS.chrome.installed
    ? parseInt(DETECTED_VERSIONS.chrome.installed.split('.')[0], 10)
    : 0;
  const fromLatest = DETECTED_VERSIONS.chrome.major || 0;
  return Math.max(fromInstalled, fromLatest, 157);
}

function detectInstalledBinaryVersions() {
  const isWindows = process.platform === 'win32';
  const chromeExe = isWindows ? 'chrome.exe' : 'chrome';
  const userHome = process.env.HOME || process.env.USERPROFILE || '';

  // Google Chrome
  try {
    const chromeCandidates = isWindows ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ] : [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ];
    for (const cp of chromeCandidates) {
      if (fs.existsSync(cp)) {
        try {
          const out = execSync(`"${cp}" --version 2>/dev/null`, { timeout: 3000 }).toString();
          const m = out.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (m) {
            DETECTED_VERSIONS.chrome.installed = m[1];
            DETECTED_VERSIONS.chrome.major = parseInt(m[1].split('.')[0], 10);
            DETECTED_VERSIONS.chrome.path = cp;
            break;
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  // GoLogin Orbita
  try {
    const orbitaBase = path.join(userHome, '.gologin', 'browser');
    if (fs.existsSync(orbitaBase)) {
      const dirs = fs.readdirSync(orbitaBase).filter(d => d.startsWith('orbita-browser-'));
      let highestOrbita = 0;
      let highestPath = null;
      for (const d of dirs) {
        const full = path.join(orbitaBase, d, chromeExe);
        if (fs.existsSync(full)) {
          const num = parseInt(d.replace('orbita-browser-', ''), 10);
          if (num > highestOrbita) {
            highestOrbita = num;
            highestPath = full;
          }
        }
      }
      if (highestOrbita > 0) {
        DETECTED_VERSIONS.orbita.installed = String(highestOrbita);
        DETECTED_VERSIONS.orbita.major = highestOrbita;
        DETECTED_VERSIONS.orbita.path = highestPath;
      }
    }
  } catch (e) {}

  // Camoufox
  try {
    const camoufoxCandidates = isWindows ? [
      path.join(process.env.LOCALAPPDATA || '', 'camoufox', 'camoufox.exe'),
      path.join(userHome, '.cache', 'camoufox', 'camoufox.exe')
    ] : [
      path.join(userHome, '.cache', 'camoufox', 'camoufox'),
      path.join(userHome, '.local', 'share', 'camoufox', 'camoufox'),
      '/usr/bin/camoufox'
    ];
    let foundCamoufoxPath = null;
    for (const p of camoufoxCandidates) {
      if (fs.existsSync(p)) {
        foundCamoufoxPath = p;
        break;
      }
    }
    if (foundCamoufoxPath) {
      DETECTED_VERSIONS.camoufox.path = foundCamoufoxPath;
      try {
        const out = execSync(`"${foundCamoufoxPath}" --version 2>/dev/null`, { timeout: 3000 }).toString();
        const m = out.match(/(\d+\.\d+(\.\d+)?)/);
        DETECTED_VERSIONS.camoufox.installed = m ? m[1] : 'Installed';
      } catch (e) {
        DETECTED_VERSIONS.camoufox.installed = 'Installed';
      }
    } else {
      DETECTED_VERSIONS.camoufox.installed = null;
    }
  } catch (e) {}
}

async function checkOnlineBrowserVersions() {
  detectInstalledBinaryVersions();
  const isWindows = process.platform === 'win32';
  const platform = isWindows ? 'win' : 'linux';

  // 1. Google Chrome (Google Version History API)
  try {
    const res = await fetch(`https://versionhistory.googleapis.com/v1/chrome/platforms/${platform}/channels/stable/versions`);
    if (res.ok) {
      const data = await res.json();
      if (data.versions && data.versions.length > 0) {
        const latestVersion = data.versions[0].version;
        DETECTED_VERSIONS.chrome.latest = latestVersion;
        const major = parseInt(latestVersion.split('.')[0], 10);
        if (major) DETECTED_VERSIONS.chrome.major = major;

        if (DETECTED_VERSIONS.chrome.installed) {
          const installedMajor = parseInt(DETECTED_VERSIONS.chrome.installed.split('.')[0], 10);
          DETECTED_VERSIONS.chrome.updateAvailable = (major > installedMajor);
          DETECTED_VERSIONS.chrome.status = DETECTED_VERSIONS.chrome.updateAvailable ? 'update_available' : 'up_to_date';
        } else {
          DETECTED_VERSIONS.chrome.updateAvailable = true;
          DETECTED_VERSIONS.chrome.status = 'not_installed';
        }
      }
    }
  } catch (e) {}

  // 2. Camoufox (GitHub Releases API)
  try {
    const res = await fetch('https://api.github.com/repos/daijro/camoufox/releases/latest', {
      headers: { 'User-Agent': 'Orbita-Anti-Detect-Manager' }
    });
    if (res.ok) {
      const data = await res.json();
      const tag = (data.tag_name || '').replace(/^v/, '');
      DETECTED_VERSIONS.camoufox.latest = tag;
      const assetTarget = isWindows ? 'win.x86_64.zip' : 'lin.x86_64.zip';
      const asset = (data.assets || []).find(a => a.name.includes(assetTarget));
      if (asset) {
        DETECTED_VERSIONS.camoufox.downloadUrl = asset.browser_download_url;
        DETECTED_VERSIONS.camoufox.sizeMb = Math.round(asset.size / (1024 * 1024));
      }
      DETECTED_VERSIONS.camoufox.updateAvailable = (!DETECTED_VERSIONS.camoufox.installed || !DETECTED_VERSIONS.camoufox.installed.includes(tag.split('-')[0]));
      DETECTED_VERSIONS.camoufox.status = DETECTED_VERSIONS.camoufox.installed ? (DETECTED_VERSIONS.camoufox.updateAvailable ? 'update_available' : 'up_to_date') : 'not_installed';
    }
  } catch (e) {}

  // 3. GoLogin Orbita
  try {
    const orbitaUrl = isWindows
      ? 'https://orbita-browser-windows.gologin.com/orbita-browser-latest.zip'
      : 'https://orbita-browser-linux.gologin.com/orbita-browser-latest.tar.gz';
    const headRes = await fetch(orbitaUrl, { method: 'HEAD' });
    if (headRes.ok) {
      DETECTED_VERSIONS.orbita.downloadUrl = orbitaUrl;
      const cl = headRes.headers.get('content-length');
      if (cl) DETECTED_VERSIONS.orbita.sizeMb = Math.round(parseInt(cl, 10) / (1024 * 1024));
      DETECTED_VERSIONS.orbita.lastModified = headRes.headers.get('last-modified');
      DETECTED_VERSIONS.orbita.status = DETECTED_VERSIONS.orbita.installed ? 'installed' : 'not_installed';
      DETECTED_VERSIONS.orbita.updateAvailable = false;
    }
  } catch (e) {}

  return DETECTED_VERSIONS;
}

// Run initial detection & profile migration
detectInstalledBinaryVersions();
checkOnlineBrowserVersions().catch(() => {});
readProfiles();

function readProfiles() {
  try {
    const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
    const profiles = JSON.parse(raw);
    let modified = false;
    const currentMajor = getLatestChromeMajor();
    const isLinux = process.platform === 'linux';

    for (const p of profiles) {
      if (p.fingerprint) {
        // 1. Auto-adapt outdated User-Agents
        if (p.fingerprint.userAgent) {
          const m = p.fingerprint.userAgent.match(/Chrome\/(\d+)/);
          if (m && parseInt(m[1], 10) < currentMajor - 2) {
            console.log(`[Auto-Adapt] Auto-upgraded outdated UA in profile '${p.name}': Chrome/${m[1]} -> Chrome/${currentMajor}`);
            p.fingerprint.userAgent = p.fingerprint.userAgent.replace(/Chrome\/\d+(\.\d+\.\d+\.\d+)?/, `Chrome/${currentMajor}.0.0.0`);
            modified = true;
          }
        }

        // 2. Auto-adapt GPU renderers: Direct3D11 is Windows-only; replace with OpenGL on Linux
        if (isLinux || (p.fingerprint.os && p.fingerprint.os.toLowerCase().includes('linux'))) {
          if (p.fingerprint.webglRenderer && p.fingerprint.webglRenderer.includes('Direct3D11')) {
            console.log(`[Auto-Adapt] Fixed Windows Direct3D renderer to Linux OpenGL for profile '${p.name}'`);
            p.fingerprint.webglRenderer = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)';
            modified = true;
          }
        }

        // 3. Auto-adapt low screen resolutions that break desktop responsive layouts (e.g. Facebook sidebars)
        if (p.fingerprint.screenResolution === '1366x768') {
          console.log(`[Auto-Adapt] Upgraded resolution from 1366x768 to 1920x1080 for profile '${p.name}'`);
          p.fingerprint.screenResolution = '1920x1080';
          modified = true;
        }
      }
    }
    if (modified) {
      saveProfiles(profiles);
    }
    return profiles;
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
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const chromeExe = isWindows ? 'chrome.exe' : 'chrome';
  const userHome = process.env.HOME || process.env.USERPROFILE || '';

  // 1. Primary Engine: GoLogin Orbita Native Chromium (DRM-free versions 146, 145, 144, 142, 132)
  const orbitaBases = [
    path.join(userHome, '.gologin', 'browser'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.gologin', 'browser'),
    '/home/abkoor/.gologin/browser'
  ].filter(Boolean);

  const candidateOrbita = [
    'orbita-browser-146',
    'orbita-browser-145',
    'orbita-browser-144',
    'orbita-browser-142',
    'orbita-browser-132'
  ];

  let foundOrbita = null;
  for (const orbitaBase of orbitaBases) {
    if (fs.existsSync(orbitaBase)) {
      for (const c of candidateOrbita) {
        const full = path.join(orbitaBase, c, chromeExe);
        if (fs.existsSync(full)) {
          foundOrbita = { path: full, version: c.replace('orbita-browser-', '') };
          break;
        }
      }
      if (foundOrbita) break;
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

  // 2. Google Chrome / Chromium (Stealth Profile)
  const chromePaths = isWindows ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ] : isMac ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome-beta',
    '/usr/bin/google-chrome-unstable'
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
  const edgePaths = isWindows ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ] : isMac ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ] : [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge-dev'
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

  // 4. Brave Browser (Stealth Profile)
  const bravePaths = isWindows ? [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
  ] : isMac ? [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  ] : [
    '/usr/bin/brave-browser',
    '/snap/bin/brave'
  ];

  for (const bp of bravePaths) {
    if (fs.existsSync(bp)) {
      engines.push({
        id: 'brave',
        name: 'Brave Browser (Stealth Profile)',
        path: bp,
        type: 'chromium',
        isDefault: engines.length === 0
      });
      break;
    }
  }

  // 5. Camoufox (Optional Firefox-based engine)
  const camoufoxCandidates = isWindows ? [
    'C:\\Users\\Administrator\\AppData\\Local\\camoufox\\camoufox\\Cache\\browsers\\official\\152.0.4-beta.30-ea52a02f\\camoufox.exe'
  ] : [
    path.join(userHome, '.cache', 'camoufox', 'camoufox'),
    path.join(userHome, '.local', 'share', 'camoufox', 'camoufox'),
    '/usr/bin/camoufox'
  ];

  let foundCamoufox = camoufoxCandidates.find(p => fs.existsSync(p));

  if (!foundCamoufox) {
    const camoufoxSearchBases = [
      path.join(process.env.LOCALAPPDATA || '', 'camoufox'),
      path.join(userHome, '.cache', 'camoufox'),
      path.join(userHome, '.local', 'share', 'camoufox')
    ];
    for (const camoufoxBase of camoufoxSearchBases) {
      if (fs.existsSync(camoufoxBase)) {
        try {
          function searchExe(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
              const full = path.join(dir, ent.name);
              if (ent.isDirectory()) {
                const res = searchExe(full);
                if (res) return res;
              } else if (ent.name === (isWindows ? 'camoufox.exe' : 'camoufox')) {
                return full;
              }
            }
            return null;
          }
          foundCamoufox = searchExe(camoufoxBase);
          if (foundCamoufox) break;
        } catch (e) {}
      }
    }
  }

  if (foundCamoufox) {
    engines.push({
      id: 'camoufox',
      name: 'Camoufox (Firefox-based Alternative)',
      path: foundCamoufox,
      type: 'camoufox',
      isDefault: engines.length === 0
    });
  } else {
    // Check for native Firefox as stealth profile engine
    const firefoxPaths = isWindows ? [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
    ] : isMac ? [
      '/Applications/Firefox.app/Contents/MacOS/firefox'
    ] : [
      '/usr/bin/firefox',
      '/snap/bin/firefox'
    ];
    for (const fp of firefoxPaths) {
      if (fs.existsSync(fp)) {
        engines.push({
          id: 'camoufox',
          name: 'Mozilla Firefox (Gecko Stealth Profile)',
          path: fp,
          type: 'camoufox',
          isDefault: engines.length === 0
        });
        break;
      }
    }
  }

  return engines;
}

// Fingerprint Generators
const GPU_PRESETS_LINUX = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080/PCIe/SSE2, OpenGL 4.5.0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080/PCIe/SSE2, OpenGL 4.5.0)' },
  { vendor: 'Google Inc. (Mesa)', renderer: 'ANGLE (Mesa, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi, navi22), OpenGL 4.6)' }
];

const GPU_PRESETS_WIN = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' }
];

const GPU_PRESETS_MAC = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2 Pro, OpenGL 4.1 Metal - 83.1)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1 Metal - 76.3)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M3 Max, OpenGL 4.1 Metal - 88.1)' }
];

const RESOLUTIONS = [
  '1920x1080',
  '2560x1440',
  '1680x1050',
  '1536x864',
  '1440x900',
  '1920x1200'
];

function generateDynamicUserAgents(targetOs = 'Windows 11') {
  const major = getLatestChromeMajor();
  const prevMajor = major - 1;
  const isMac = targetOs && targetOs.toLowerCase().includes('mac');
  const isLinux = targetOs && targetOs.toLowerCase().includes('linux');

  if (isMac) {
    return [
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${prevMajor}.0.0.0 Safari/537.36`
    ];
  } else if (isLinux) {
    return [
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    ];
  } else {
    // Windows 11 default
    return [
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${prevMajor}.0.0.0 Safari/537.36`
    ];
  }
}

function generateFingerprint(os = 'Windows 11') {
  const isMac = os && os.toLowerCase().includes('mac');
  const isLinux = os && os.toLowerCase().includes('linux');
  const gpuList = isMac ? GPU_PRESETS_MAC : (isLinux || process.platform === 'linux') ? GPU_PRESETS_LINUX : GPU_PRESETS_WIN;
  const gpu = gpuList[Math.floor(Math.random() * gpuList.length)];
  const res = RESOLUTIONS[Math.floor(Math.random() * RESOLUTIONS.length)];
  const cores = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
  const ram = [8, 16, 32][Math.floor(Math.random() * 3)];
  
  const uas = generateDynamicUserAgents(os);
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

// Open Profile Folder in File Manager (Explorer on Windows, xdg-open on Linux, open on macOS)
app.post('/api/profiles/:id/open-folder', (req, res) => {
  const id = req.params.id;
  const profDir = path.join(PROFILES_DIR, id);
  if (!fs.existsSync(profDir)) fs.mkdirSync(profDir, { recursive: true });

  const openCmd = process.platform === 'win32'
    ? `explorer.exe "${profDir}"`
    : process.platform === 'darwin'
      ? `open "${profDir}"`
      : `xdg-open "${profDir}"`;

  exec(openCmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Launch Browser for a Profile
async function launchBrowserProcess(profile, targetUrl = 'https://browserleaks.com') {
  const engines = findAvailableEngines();
  let selectedEngine = null;

  if (profile.engine && profile.engine !== 'auto') {
    selectedEngine = engines.find(e => e.id === profile.engine || (profile.engine === 'camoufox' && e.type === 'camoufox'));
  }
  if (!selectedEngine && engines.length > 0) {
    selectedEngine = engines[0];
  }

  if (!selectedEngine) {
    throw new Error('No compatible browser engine found on system.');
  }

  const profileDir = path.join(PROFILES_DIR, profile.id);
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  // Auto-adapt outdated profile User-Agents to current engine standards
  const currentMajor = getLatestChromeMajor();
  if (profile.fingerprint?.userAgent) {
    const match = profile.fingerprint.userAgent.match(/Chrome\/(\d+)/);
    if (match) {
      const profVer = parseInt(match[1], 10);
      if (profVer < currentMajor - 2) {
        console.log(`[Auto-Adapt] Upgrading outdated User-Agent for profile '${profile.name}': Chrome/${profVer} -> Chrome/${currentMajor}`);
        profile.fingerprint.userAgent = profile.fingerprint.userAgent.replace(/Chrome\/\d+(\.\d+\.\d+\.\d+)?/, `Chrome/${currentMajor}.0.0.0`);
        const allProfiles = readProfiles();
        const pIdx = allProfiles.findIndex(p => p.id === profile.id);
        if (pIdx !== -1) {
          allProfiles[pIdx].fingerprint.userAgent = profile.fingerprint.userAgent;
          saveProfiles(allProfiles);
        }
      }
    }
  }

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
    // Chromium / Chrome / Orbita configuration & arguments
    // 1. Generate GoLogin / Orbita internal configuration (orbita.config and Preferences)
    const isWin = profile.fingerprint?.os && profile.fingerprint.os.includes('Windows');
    const [resW, resH] = (profile.fingerprint?.screenResolution || '1920x1080').split('x').map(n => parseInt(n, 10));
    const finalW = resW || 1920;
    const finalH = resH || 1080;
    const ramGb = profile.fingerprint?.ramGb || 8;
    const cpuCores = profile.fingerprint?.cpuCores || 8;

    // Align User-Agent with engine's real Chromium base version (prevents TLS JA4 handshake mismatch)
    let effectiveUA = profile.fingerprint?.userAgent;
    if (selectedEngine.id === 'orbita') {
      const orbitaMajor = selectedEngine.name.match(/v(\d+)/)?.[1] || '146';
      if (effectiveUA) {
        effectiveUA = effectiveUA.replace(/Chrome\/\d+(\.\d+\.\d+\.\d+)?/, `Chrome/${orbitaMajor}.0.0.0`);
      }
    }

    const orbitaConfig = {
      intl: {
        language: profile.fingerprint?.language || 'en-US,en;q=0.9',
        timezone: profile.fingerprint?.timezoneMode === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
      },
      gologin: {
        profile_id: profile.id,
        name: profile.name,
        userAgent: effectiveUA || generateDynamicUserAgents(profile.fingerprint?.os)[0],
        screenResolution: `${finalW}x${finalH}`,
        screenWidth: finalW,
        screenHeight: finalH,
        deviceMemory: ramGb * 1024,
        hardwareConcurrency: cpuCores,
        navigator: {
          platform: isWin ? 'Win32' : 'Linux x86_64',
          max_touch_points: 0,
          hardwareConcurrency: cpuCores,
          deviceMemory: ramGb * 1024
        },
        webGl: {
          mode: true,
          vendor: profile.fingerprint?.webglVendor || 'Google Inc. (NVIDIA)',
          renderer: profile.fingerprint?.webglRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)'
        },
        webgl: {
          metadata: {
            vendor: profile.fingerprint?.webglVendor || 'Google Inc. (NVIDIA)',
            renderer: profile.fingerprint?.webglRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)'
          }
        }
      }
    };

    try {
      fs.writeFileSync(path.join(profileDir, 'orbita.config'), JSON.stringify(orbitaConfig, null, 2), 'utf8');
      const defaultPrefDir = path.join(profileDir, 'Default');
      if (!fs.existsSync(defaultPrefDir)) fs.mkdirSync(defaultPrefDir, { recursive: true });
      const prefPath = path.join(defaultPrefDir, 'Preferences');
      let existingPrefs = {};
      try {
        if (fs.existsSync(prefPath)) existingPrefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      } catch (e) {}
      existingPrefs.gologin = orbitaConfig.gologin;
      fs.writeFileSync(prefPath, JSON.stringify(existingPrefs, null, 2), 'utf8');
    } catch (cfgErr) {
      console.warn('[Engine Config] Notice: could not write orbita.config:', cfgErr.message);
    }

    // 2. Chromium launch flags
    args.push(`--user-data-dir=${profileDir}`);
    args.push('--no-first-run');
    args.push('--no-default-browser-check');
    args.push('--disable-blink-features=AutomationControlled');
    args.push('--password-store=basic');
    args.push('--ignore-gpu-blocklist');
    args.push('--enable-gpu-rasterization');
    args.push('--enable-zero-copy');
    if (process.platform === 'linux') {
      args.push('--use-gl=angle');
      args.push('--use-angle=vulkan');
    }

    if (profile.fingerprint?.screenResolution) {
      args.push(`--window-size=${finalW},${finalH}`);
    }

    if (effectiveUA) {
      args.push(`--user-agent=${effectiveUA}`);
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
        'User-Agent': generateDynamicUserAgents()[0]
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

// -------------------------------------------------------------
// ENGINE UPDATE & NOTIFICATION SYSTEM (ALL 3 BROWSERS)
// -------------------------------------------------------------

// 1. Get Updates Status
app.get('/api/updates/status', async (req, res) => {
  try {
    const status = await checkOnlineBrowserVersions();
    const updatesList = [];
    
    if (status.chrome.updateAvailable) updatesList.push('chrome');
    if (status.orbita.updateAvailable) updatesList.push('orbita');
    if (status.camoufox.updateAvailable) updatesList.push('camoufox');

    res.json({
      success: true,
      engines: status,
      totalUpdatesAvailable: updatesList.length,
      updatesList,
      latestChromeMajor: getLatestChromeMajor()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Manual Trigger Check for Updates
app.post('/api/updates/check', async (req, res) => {
  try {
    const status = await checkOnlineBrowserVersions();
    res.json({ success: true, engines: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Download Progress
app.get('/api/updates/progress', (req, res) => {
  res.json(DOWNLOAD_PROGRESS);
});

// Helper function for completely non-blocking background downloads with live progress
function downloadAndExtractAsync({ engine, downloadUrl, destDir, archiveName, isZip, totalMbEstimate, postInstallCmds }) {
  DOWNLOAD_PROGRESS = {
    engine,
    percent: 5,
    status: 'downloading',
    message: `Connecting to ${engine} server...`
  };

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const archivePath = path.join(destDir, archiveName);
  try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (e) {}

  const curlProc = spawn('curl', ['-L', '--fail', '-o', archivePath, downloadUrl], {
    detached: false,
    stdio: 'ignore'
  });

  const totalBytes = (totalMbEstimate && totalMbEstimate > 0) ? totalMbEstimate * 1024 * 1024 : 0;
  const progressTimer = setInterval(() => {
    try {
      if (fs.existsSync(archivePath)) {
        const stat = fs.statSync(archivePath);
        const currentBytes = stat.size;
        const currentMb = (currentBytes / (1024 * 1024)).toFixed(1);
        const totalMbStr = totalMbEstimate ? `${totalMbEstimate} MB` : '...';
        let pct = totalBytes > 0 ? Math.min(90, Math.round((currentBytes / totalBytes) * 90)) : 45;
        pct = Math.max(5, pct);
        DOWNLOAD_PROGRESS.percent = pct;
        DOWNLOAD_PROGRESS.message = `Downloading ${engine} package: ${currentMb} MB / ${totalMbStr} (${pct}%)`;
      }
    } catch (e) {}
  }, 400);

  curlProc.on('error', (err) => {
    clearInterval(progressTimer);
    console.error(`[Updater] Download error for ${engine}:`, err);
    DOWNLOAD_PROGRESS = { engine, percent: 0, status: 'error', message: 'Download failed: ' + err.message };
  });

  curlProc.on('close', (code) => {
    clearInterval(progressTimer);
    if (code !== 0) {
      console.error(`[Updater] curl exited with code ${code} for ${engine}`);
      DOWNLOAD_PROGRESS = { engine, percent: 0, status: 'error', message: `Download failed (curl exit code ${code})` };
      return;
    }

    DOWNLOAD_PROGRESS.percent = 92;
    DOWNLOAD_PROGRESS.message = `Extracting ${engine} files, please wait...`;

    let extractProc;
    if (isZip) {
      if (process.platform === 'win32') {
        extractProc = spawn('powershell', ['-command', `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`], { stdio: 'ignore' });
      } else {
        extractProc = spawn('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'ignore' });
      }
    } else {
      extractProc = spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'ignore' });
    }

    extractProc.on('error', (err) => {
      console.error(`[Updater] Extraction error for ${engine}:`, err);
      DOWNLOAD_PROGRESS = { engine, percent: 0, status: 'error', message: 'Extraction failed: ' + err.message };
    });

    extractProc.on('close', (extractCode) => {
      try { fs.unlinkSync(archivePath); } catch (e) {}
      if (extractCode !== 0) {
        console.error(`[Updater] Extraction exited with code ${extractCode}`);
        DOWNLOAD_PROGRESS = { engine, percent: 0, status: 'error', message: `Extraction failed (code ${extractCode})` };
        return;
      }

      if (postInstallCmds && Array.isArray(postInstallCmds)) {
        for (const cmd of postInstallCmds) {
          try { execSync(cmd); } catch (e) {}
        }
      }

      detectInstalledBinaryVersions();
      DOWNLOAD_PROGRESS = {
        engine,
        percent: 100,
        status: 'done',
        message: `${engine.toUpperCase()} engine installed and configured successfully!`
      };
      console.log(`[Updater] ${engine} installed successfully.`);
    });
  });
}

// 4. Download and Install an Engine (Notify-first approval)
app.post('/api/updates/download', async (req, res) => {
  const { engine } = req.body;
  if (!['camoufox', 'orbita', 'chrome'].includes(engine)) {
    return res.status(400).json({ error: 'Valid engine must be specified: camoufox, orbita, or chrome' });
  }

  if (DOWNLOAD_PROGRESS.status === 'downloading') {
    return res.status(409).json({ error: 'Another download is already in progress' });
  }

  const userHome = process.env.HOME || process.env.USERPROFILE || '';
  const isWindows = process.platform === 'win32';

  if (engine === 'camoufox') {
    const downloadUrl = DETECTED_VERSIONS.camoufox.downloadUrl;
    if (!downloadUrl) {
      return res.status(400).json({ error: 'Camoufox download URL not available. Please check updates first.' });
    }

    res.json({ success: true, message: 'Camoufox download initiated' });
    const destDir = path.join(userHome, '.cache', 'camoufox');
    downloadAndExtractAsync({
      engine: 'camoufox',
      downloadUrl,
      destDir,
      archiveName: 'camoufox_package.zip',
      isZip: true,
      totalMbEstimate: DETECTED_VERSIONS.camoufox.sizeMb || 1240,
      postInstallCmds: isWindows ? [] : [`chmod +x "${destDir}"/camoufox* 2>/dev/null || true`]
    });
  } else if (engine === 'orbita') {
    const downloadUrl = DETECTED_VERSIONS.orbita.downloadUrl || (isWindows
      ? 'https://orbita-browser-windows.gologin.com/orbita-browser-latest.zip'
      : 'https://orbita-browser-linux.gologin.com/orbita-browser-latest.tar.gz');

    res.json({ success: true, message: 'Orbita download initiated' });
    const destDir = path.join(userHome, '.gologin', 'browser');
    downloadAndExtractAsync({
      engine: 'orbita',
      downloadUrl,
      destDir,
      archiveName: isWindows ? 'orbita-browser-latest.zip' : 'orbita-browser-latest.tar.gz',
      isZip: isWindows,
      totalMbEstimate: DETECTED_VERSIONS.orbita.sizeMb || 220,
      postInstallCmds: isWindows ? [] : [`chmod +x "${destDir}"/orbita-browser-*/chrome 2>/dev/null || true`]
    });
  } else if (engine === 'chrome') {
    DOWNLOAD_PROGRESS = { engine: 'chrome', percent: 10, status: 'downloading', message: 'Checking Google Chrome...' };
    res.json({ success: true, message: 'Chrome update check initiated' });

    (async () => {
      try {
        if (!isWindows) {
          DOWNLOAD_PROGRESS.message = 'Google Chrome is already installed natively on system.';
          DOWNLOAD_PROGRESS.percent = 80;
        }
        detectInstalledBinaryVersions();
        DOWNLOAD_PROGRESS = { engine: 'chrome', percent: 100, status: 'done', message: 'Google Chrome is up to date!' };
      } catch (err) {
        DOWNLOAD_PROGRESS = { engine: 'chrome', percent: 0, status: 'error', message: err.message };
      }
    })();
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
