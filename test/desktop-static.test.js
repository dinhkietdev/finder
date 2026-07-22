const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

test('desktop main/preload syntax is valid', () => {
  execFileSync(process.execPath, ['--check', 'desk/main.js']);
  execFileSync(process.execPath, ['--check', 'desk/preload.js']);
  execFileSync(process.execPath, ['--check', 'desk/upload-fingerprint.js']);
});

test('client and desktop inline scripts parse', () => {
  for (const file of ['client.html', 'desk/index.html']) {
    const html = fs.readFileSync(file, 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1]).filter(Boolean);
    if (file === 'client.html') scripts.push(fs.readFileSync('assets/client.js', 'utf8'));
    assert.ok(scripts.length, `${file} should contain a script`);
    scripts.forEach((source, index) => new vm.Script(source, { filename: `${file}#${index + 1}` }));
  }
});

test('culling preview uses a local URL instead of Base64 IPC data', () => {
  const source = fs.readFileSync('desk/main.js', 'utf8');
  const handler = source.slice(source.indexOf("ipcMain.handle('get-culling-original'"), source.indexOf("ipcMain.handle('get-culling-preview'"));
  assert.match(handler, /previewUrl/);
  assert.doesNotMatch(handler, /data:image\/jpeg;base64/);
  assert.doesNotMatch(source, /data:image\/jpeg;base64/);
});

test('desktop limit editing can bootstrap legacy albums and exposes server errors', () => {
  const source = fs.readFileSync('desk/main.js', 'utf8');
  const start = source.indexOf("ipcMain.handle('update-album-settings'");
  const end = source.indexOf("ipcMain.handle('get-album-thumbnail'", start);
  const handler = source.slice(start, end);
  assert.match(handler, /driveAccessHeaders\(oauth2Client\)/);
  assert.match(handler, /managementToken/);
  assert.match(handler, /requestId/);
  assert.match(handler, /statusCode/);
});

test('explicit limit saves reopen selection even when the value is unchanged', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  assert.match(source, /if \(hasLimitUpdate && !isBackgroundSync\) \{/);
  assert.match(source, /Older desktop builds did not send `reopenSelection`/);
});

test('confirmed albums use the compact full thumbnail path', () => {
  const serverSource = fs.readFileSync('server.js', 'utf8');
  const clientSource = fs.readFileSync('assets/client.js', 'utf8');
  assert.match(serverSource, /fullResponse = String\(req\.query\?\.full \|\| ''\) === '1'/);
  assert.match(serverSource, /compactResponse = fullResponse \|\| String\(req\.query\?\.compact \|\| ''\) === '1'/);
  assert.match(clientSource, /workflowStatus === 'selection_confirmed'/);
  assert.match(clientSource, /new URLSearchParams\(\{ full: '1', compact: '1', refresh: '1' \}\)/);
  assert.match(clientSource, /eagerThumbnails/);
});

test('selected-photo lightbox navigates only the selected subset', () => {
  const source = fs.readFileSync('assets/client.js', 'utf8');
  assert.match(source, /lightboxNavigation/);
  assert.match(source, /getSelectedLightboxImages/);
  assert.match(source, /openLightbox\(\{ mode: 'selection', fullName: item\.fullName \}\)/);
});

test('fresh CHECK opens by default while reopened selections stay on originals', () => {
  const source = fs.readFileSync('assets/client.js', 'utf8');
  assert.match(source, /function shouldOpenLatestCheckByDefault\(\)/);
  assert.match(source, /\['check_pending', 'revision_requested', 'completed'\]\.includes\(status\)/);
  assert.match(source, /reopenedAt > checkAt/);
  assert.match(source, /function openLatestCheckViewIfNeeded\(\)/);
  assert.match(source, /state\.viewMode = 'check';/);
  assert.match(source, /state\.viewMode === 'check' && state\.checkImages\.length/);
});

test('network album snapshots remove deleted Drive files after cached hydration', () => {
  const clientSource = fs.readFileSync('assets/client.js', 'utf8');
  const serverSource = fs.readFileSync('server.js', 'utf8');
  assert.match(clientSource, /networkOriginalKeys/);
  assert.match(clientSource, /reconcileNetworkAlbumSnapshot\(\)/);
  assert.match(clientSource, /state\.originalImages = state\.originalImages\.filter/);
  assert.match(serverSource, /const refreshRequested = String\(req\.query\?\.refresh \|\| ''\) === '1'/);
  assert.match(serverSource, /!refreshRequested && !pagedResponse/);
  assert.match(clientSource, /new URLSearchParams\(\{ full: '1', compact: '1', refresh: '1' \}\)/);
});

test('review tabs show original photos before edited CHECK photos', () => {
  const html = fs.readFileSync('client.html', 'utf8');
  const bar = html.slice(html.indexOf('id="reviewModeBar"'), html.indexOf('</div>', html.indexOf('id="reviewModeBar"')) + 6);
  assert.ok(bar.indexOf('id="originalModeBtn"') < bar.indexOf('id="checkModeBtn"'));
});

test('comparison lightbox supports shared zoom and pan', () => {
  const source = fs.readFileSync('assets/client.js', 'utf8');
  const css = fs.readFileSync('assets/client.css', 'utf8');
  assert.match(source, /compareZoomScale/);
  assert.match(source, /applyCompareZoom\(\)/);
  assert.match(source, /elements\.compareStage\.addEventListener\('wheel'/);
  assert.match(source, /elements\.compareStage\.addEventListener\('pointermove'/);
  assert.match(css, /\.compare-image\.compare-zoomed/);
});

test('album settings writes run in parallel with a bounded Vercel deadline', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf("app.post('/api/album/:folderId/settings'");
  const end = source.indexOf("// Desktop history is cached locally", start);
  const handler = source.slice(start, end);
  assert.match(handler, /settingsWriteTimeoutMs = 3500/);
  assert.match(handler, /Promise\.allSettled\(\[brandingTask, persistenceTask\]\)/);
  assert.match(handler, /persistencePending/);
});

test('upload finalization has bounded network waits', () => {
  const source = fs.readFileSync('desk/main.js', 'utf8');
  assert.match(source, /ONLINE_REQUEST_TIMEOUT_MS/);
  assert.match(source, /request\.setTimeout\(timeoutMs/);
  assert.match(source, /postServerJson\(`\/api\/album\/\$\{googleDriveFolderId\}\/settings`/);
  assert.match(source, /ALBUM_TOKEN_SYNC_TIMEOUT_MS/);
});

test('Supabase REST writes abort instead of keeping Vercel functions open', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  assert.match(source, /SUPABASE_REQUEST_TIMEOUT_MS/);
  assert.match(source, /AbortSignal\.timeout\(requestTimeoutMs\)/);
  assert.match(source, /timeoutMs: ALBUM_STATE_REQUEST_TIMEOUT_MS/);
  assert.match(source, /DRIVE_PROOF_TIMEOUT_MS/);
  assert.match(source, /promiseWithTimeout\(/);
  assert.match(source, /PERSISTENT_STATE_UNAVAILABLE/);
  assert.match(source, /loadSupabaseAlbumState\(folderId\)/);
  assert.match(source, /albums\?id=eq\./);
});

test('interrupted upload sessions can be cancelled without deleting Drive files', () => {
  const main = fs.readFileSync('desk/main.js', 'utf8');
  const html = fs.readFileSync('desk/index.html', 'utf8');
  assert.match(main, /ipcMain\.handle\('cancel-upload-job'/);
  assert.match(main, /removeUploadJob\(id\)/);
  assert.match(html, /id="btn-cancel-resume-upload"/);
  assert.match(html, /ipcRenderer\.invoke\('cancel-upload-job'/);
  assert.match(html, /Google Drive sẽ không bị xóa/);
});
