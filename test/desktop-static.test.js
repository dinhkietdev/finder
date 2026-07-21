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
