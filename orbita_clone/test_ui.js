const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

async function testUI() {
  console.log('--- STARTING COMPLETE UI & UX AUTOMATION TEST ---');
  
  // 1. Start Server
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit'
  });
  await new Promise(r => setTimeout(r, 1500));

  let browser;
  try {
    const chromePath = getChromeExecutable();
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error('BROWSER CONSOLE ERROR:', msg.text());
        errors.push(msg.text());
      } else {
        console.log('BROWSER LOG:', msg.text());
      }
    });
    page.on('pageerror', err => {
      console.error('PAGE ERROR:', err.message);
      errors.push(err.message);
    });

    // 2. Load page
    console.log('1. Loading http://localhost:3030...');
    await page.goto('http://localhost:3030', { waitUntil: 'networkidle0' });

    const title = await page.title();
    console.log(' -> Page Title:', title);
    if (!title.includes('Orbita')) throw new Error('Incorrect page title');

    // 3. Test New Profile Button
    console.log('2. Testing #btn-create-profile click...');
    await page.evaluate(() => document.getElementById('btn-create-profile').click());
    await new Promise(r => setTimeout(r, 400));
    const modalVisible = await page.$eval('#profile-modal', el => el.classList.contains('show'));
    console.log(' -> Create Modal is visible:', modalVisible);
    if (!modalVisible) throw new Error('Create modal did not open');

    // 4. Test Tab Switching
    console.log('3. Testing modal tab switching...');
    await page.click('[data-tab="tab-proxy"]');
    await new Promise(r => setTimeout(r, 200));
    const proxyTabActive = await page.$eval('#tab-proxy', el => el.classList.contains('active'));
    console.log(' -> Proxy tab active:', proxyTabActive);
    if (!proxyTabActive) throw new Error('Proxy tab did not activate');

    await page.click('[data-tab="tab-fingerprint"]');
    await new Promise(r => setTimeout(r, 200));
    const fpTabActive = await page.$eval('#tab-fingerprint', el => el.classList.contains('active'));
    console.log(' -> Fingerprint tab active:', fpTabActive);
    if (!fpTabActive) throw new Error('Fingerprint tab did not activate');

    // 5. Test Randomize Fingerprint
    console.log('4. Testing Randomize Fingerprint button...');
    await page.click('#btn-randomize-fp');
    await new Promise(r => setTimeout(r, 500));
    const newUa = await page.$eval('#fp-ua', el => el.value);
    console.log(' -> Fingerprint UA populated:', Boolean(newUa));

    // 6. Save Profile
    console.log('5. Saving profile...');
    await page.click('[data-tab="tab-general"]');
    await page.evaluate(() => {
      document.getElementById('p-name').value = 'Automated Test Profile';
      document.getElementById('modal-save-btn').click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // Check table
    const tableRows = await page.$$eval('#profiles-table-body tr', rows => rows.length);
    console.log(' -> Table rows after creation:', tableRows);
    if (tableRows === 0) throw new Error('Profile row was not added');

    const profileModalStillOpen = await page.$eval('#profile-modal', el => el.classList.contains('show'));
    console.log(' -> Profile modal closed:', !profileModalStillOpen);

    // 7. Test Bulk Add Modal
    console.log('6. Testing Bulk Add modal...');
    await page.evaluate(() => document.getElementById('btn-open-bulk-modal').click());
    await new Promise(r => setTimeout(r, 500));
    const bulkModalVisible = await page.$eval('#bulk-modal', el => el.classList.contains('show'));
    console.log(' -> Bulk modal visible:', bulkModalVisible);
    if (!bulkModalVisible) throw new Error('Bulk modal did not open');

    await page.$eval('#bulk-count', el => el.value = '3');
    await page.$eval('#bulk-basename', el => el.value = 'BulkAgent');
    await page.evaluate(() => document.getElementById('btn-execute-bulk-create').click());
    await new Promise(r => setTimeout(r, 2500));

    const totalRowsAfterBulk = await page.$$eval('#profiles-table-body tr', rows => rows.length);
    console.log(' -> Total table rows after bulk create:', totalRowsAfterBulk);
    if (totalRowsAfterBulk < tableRows + 3) throw new Error('Bulk profiles not created');

    // 8. Test Checkbox & Bulk Bar
    console.log('7. Testing Row Checkbox...');
    await page.evaluate(() => {
      const cb = document.querySelector('.profile-row-checkbox');
      if (cb) cb.click();
    });
    await new Promise(r => setTimeout(r, 500));
    const bulkBarVisible = await page.$eval('#bulk-bar', el => el.style.display !== 'none');
    console.log(' -> Bulk bar visible after checking row:', bulkBarVisible);
    if (!bulkBarVisible) throw new Error('Bulk action bar did not appear');

    // 9. Test Master Checkbox
    console.log('8. Testing Select All Checkbox...');
    await page.evaluate(() => document.getElementById('select-all-checkbox').click());
    await new Promise(r => setTimeout(r, 500));
    const selectedCount = await page.$eval('#bulk-selected-count', el => parseInt(el.textContent, 10));
    console.log(' -> Selected count with master checkbox:', selectedCount);
    if (selectedCount < totalRowsAfterBulk) throw new Error('Select all failed');

    // 10. Test Bulk Randomize Fingerprints
    console.log('9. Testing Bulk Randomize Fingerprints...');
    await page.evaluate(() => document.getElementById('btn-bulk-fp').click());
    await new Promise(r => setTimeout(r, 1000));
    const toast = await page.$eval('.toast', el => el.textContent);
    console.log(' -> Toast notification captured:', toast.trim());

    // 11. Test Search Box Filter
    console.log('10. Testing Search filter...');
    await page.type('#search-input', 'BulkAgent');
    await new Promise(r => setTimeout(r, 500));
    const filteredRows = await page.$$eval('#profiles-table-body tr', rows => rows.length);
    console.log(' -> Filtered rows matching "BulkAgent":', filteredRows);
    if (filteredRows === 0) throw new Error('Search filtering failed');

    await page.evaluate(() => document.getElementById('clear-search-btn').click());
    await new Promise(r => setTimeout(r, 400));

    // 12. Check error log
    if (errors.length > 0) {
      throw new Error(`Encountered ${errors.length} browser errors: ` + errors.join('; '));
    }

    console.log('\n=================================================');
    console.log('>>> ALL 10 UI/UX AND BUTTON TESTS PASSED 100%! <<<');
    console.log('=================================================\n');

  } catch (err) {
    console.error('UI TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

testUI();
