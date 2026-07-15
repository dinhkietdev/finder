const test = require('node:test');
const assert = require('node:assert/strict');

// Production mode prevents server.js from opening its fixed development port;
// this test creates an ephemeral listener below.
process.env.NODE_ENV = 'production';
process.env.FINDER_OAUTH_STATE_SECRET = 'test-only-oauth-secret';
process.env.GOOGLE_OAUTH_CREDENTIALS = JSON.stringify({ web: {
  client_id: 'test-client-id.apps.googleusercontent.com',
  client_secret: 'test-client-secret'
} });
process.env.FINDER_REQUIRE_SUPABASE = '0';

const app = require('../server');
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('health exposes readiness without secrets', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.ok([200, 503].includes(response.status));
  assert.match(response.headers.get('x-request-id') || '', /^[A-Za-z0-9._:-]{8,120}$/);
  const body = await response.json();
  assert.equal(typeof body.oauthStateSecret, 'boolean');
  assert.equal(typeof body.tokenEncryptionKey, 'boolean');
  assert.equal(typeof body.directDownloads, 'boolean');
  assert.equal(typeof body.alertWebhook, 'boolean');
});

test('Drive authorize returns a signed OAuth URL', async () => {
  const response = await fetch(`${baseUrl}/api/auth/drive-authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.match(body.authUrl, /^https:\/\/accounts\.google\.com\//);
  assert.match(body.authUrl, /state=/);
});

test('invalid OAuth state is rejected', async () => {
  const response = await fetch(`${baseUrl}/api/auth/drive-exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invalid', state: 'invalid' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'OAUTH_STATE_INVALID');
});

test('credential files are never served', async () => {
  for (const pathname of ['/oauth-credentials.json', '/database.json', '/desk/oauth-credentials.json', '/desk/firebase-auth-config.js']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});

test('production never falls back to legacy album storage', async () => {
  const response = await fetch(`${baseUrl}/api/album/test-album`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SUPABASE_REQUIRED');
});
