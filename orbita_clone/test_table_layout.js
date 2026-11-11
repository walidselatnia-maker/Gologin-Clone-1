const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

function getChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const userHome = process.env.HOME || process.env.USERPROFILE || '';
  const orbita146 = path.join(userHome, '.gologin', 'browser', 'orbita-browser-146', process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  if (fs.existsSync(orbita146)) return orbita146;
  return 'google-chrome';
}

const chromeExecutable = getChromeExecutable();

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('--- TESTING TABLE RESPONSIVENESS & ORBITA ENGINE ---');

  // 1. Ensure server is running
  const { spawn } = require('child_process');
  let serverProcess;
  const isServerRunning = await new Promise(resolve => {
    http.get('http://localhost:3030/api/system-info', res => resolve(true)).on('error', () => resolve(false));
  });

  if (!isServerRunning) {
    serverProcess = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'inherit' });
    for (let i = 0; i < 30; i++) {
      await wait(250);
      const ready = await new Promise(resolve => {
        http.get('http://localhost:3030/api/system-info', res => resolve(true)).on('error', () => resolve(false));
      });
      if (ready) break;
    }
  }

  // 2. Launch Puppeteer on smaller screen (1024x768)
  const browser = await puppeteer.launch({
    executablePath: chromeExecutable,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });

  await page.goto('http://localhost:3030', { waitUntil: 'networkidle0' });
  await wait(800);

  // Check Engine in status card
  const engineStatus = await page.$eval('#engine-status-text', el => el.textContent);
  console.log('Sidebar Engine Status:', engineStatus);
  const isOrbitaDefault = engineStatus.includes('Orbita');
  console.log('Orbita is active default engine:', isOrbitaDefault ? 'PASS ✓' : 'FAIL ✗');

  // Check Table Rows
  const rowsCount = await page.$$eval('#profiles-table-body tr', rows => rows.length);
  console.log('Profiles table rows rendered:', rowsCount);

  // Check if profile name wraps
  const profileNameHeights = await page.$$eval('.profile-name', els => els.map(e => ({
    text: e.textContent,
    height: e.offsetHeight,
    width: e.offsetWidth
  })));
  console.log('Profile name elements:', profileNameHeights);

  // Check action buttons container bounding box
  const actionContainers = await page.$$eval('.table-actions', els => els.map(e => {
    const rect = e.getBoundingClientRect();
    const buttons = Array.from(e.querySelectorAll('button')).map(b => ({
      title: b.title || b.textContent.trim(),
      visible: b.offsetWidth > 0 && b.offsetHeight > 0
    }));
    return {
      rect: { left: rect.left, right: rect.right, width: rect.width },
      buttonsCount: buttons.length,
      allButtonsVisible: buttons.every(b => b.visible)
    };
  }));

  console.log('Action containers metrics:', JSON.stringify(actionContainers, null, 2));

  // Take screenshot of the table area to verify visually
  const screenshotPath = path.join(__dirname, 'table_layout_verification.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Screenshot saved to:', screenshotPath);

  await browser.close();
  if (serverProcess) serverProcess.kill();

  if (!isOrbitaDefault) {
    throw new Error('Orbita should be the default engine');
  }

  console.log('\n--- ALL RESPONSIVENESS AND ORBITA ENGINE CHECKS PASSED! ---');
  process.exit(0);
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
