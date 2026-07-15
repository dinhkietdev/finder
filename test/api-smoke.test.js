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
  assert.equal(typeof body.guestCapabilitySecret, 'boolean');
  assert.equal(typeof body.directDownloads, 'boolean');
  assert.ok(['supabase', 'none'].includes(body.alertSink));
  assert.equal(typeof body.alertWebhook, 'boolean');
  assert.equal(typeof body.rateLimitMetrics?.requests, 'number');
  assert.equal(typeof body.rateLimitMetrics?.memoryFallback, 'number');
  assert.match(response.headers.get('x-ratelimit-limit') || '', /^\d+$/);
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

test('thumbnail cleanup requires the cron secret', async () => {
  const response = await fetch(`${baseUrl}/api/internal/cleanup-thumbnails`);
  // Production also refuses storage jobs before routing when Supabase is not
  // configured; once configured, the same request reaches the 401 guard.
  assert.ok([401, 503].includes(response.status));
  assert.equal((await response.json()).success, false);
});

test('guest writes cannot create or mutate an unknown album', async () => {
  const response = await fetch(`${baseUrl}/api/album/unknown-album/toggle-like`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: '01.jpg', isLiked: true })
  });
  assert.ok([404, 503].includes(response.status));
  const body = await response.json();
  if (response.status === 404) assert.equal(body.code, 'ALBUM_NOT_FOUND');
  else assert.equal(body.code, 'SUPABASE_REQUIRED');
});
