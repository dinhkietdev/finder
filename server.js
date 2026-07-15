const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { createObservability } = require('./server/observability');
const { createRateLimitMiddleware } = require('./server/rate-limit');
const { slugifyAlbumName, canonicalPublicSlug, normalizeDriveFolderId, escapeHtmlAttribute } = require('./server/public-slug');

const app = express();
app.disable('x-powered-by');
const REQUIRE_SUPABASE_STORAGE = process.env.FINDER_REQUIRE_SUPABASE === '1'
    || process.env.NODE_ENV === 'production';
const REQUEST_ID_HEADER = 'x-request-id';
const driveImageMetadataCache = new Map();
const DRIVE_IMAGE_METADATA_TTL_MS = 5 * 60 * 1000;

function albumExists(folderId) {
    return Object.prototype.hasOwnProperty.call(albumSettingsDatabase, String(folderId))
        || Object.prototype.hasOwnProperty.call(albumCacheDatabase, String(folderId));
}

function encodeAlbumPageCursor(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeAlbumPageCursor(value) {
    if (!value) return {};
    try {
        const decoded = Buffer.from(String(value), 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return null;
    }
}

const { createRequestId, logStructuredEvent, sendAlert } = createObservability({ persistApiAlert });

app.use((req, res, next) => {
    const incoming = String(req.get(REQUEST_ID_HEADER) || '').trim();
    const requestId = /^[A-Za-z0-9._:-]{8,120}$/.test(incoming) ? incoming : createRequestId();
    req.requestId = requestId;
    res.set(REQUEST_ID_HEADER, requestId);
    const startedAt = Date.now();
    res.on('finish', () => {
        if (!req.path.startsWith('/api/')) return;
        const status = res.statusCode;
        const entry = { requestId, method: req.method, path: req.path, status, durationMs: Date.now() - startedAt, ip: req.ip || 'unknown' };
        logStructuredEvent(status >= 500 ? 'api.error' : status >= 400 ? 'api.client_error' : 'api.request', entry);
        if (status >= 500 || status === 429) sendAlert({ ...entry, event: status === 429 ? 'api.rate_limited' : 'api.error' });
    });
    next();
});
const allowedOrigins = String(process.env.FINDER_ALLOWED_ORIGINS || 'https://finder-swart-pi.vercel.app,http://localhost:5000,http://localhost:3000')
    .split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({ credentials: true, origin(origin, callback) {
    // Native desktop requests do not include Origin; keep them working.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin không được phép.'));
} }));
app.use(bodyParser.json({ limit: process.env.FINDER_JSON_LIMIT || '256kb' }));

const rateLimitMiddleware = createRateLimitMiddleware({
    isSupabaseConfigured,
    supabaseRequest,
    logStructuredEvent,
    requireSupabaseStorage: REQUIRE_SUPABASE_STORAGE
});
app.use('/api/', rateLimitMiddleware);

// Credential/session files are only for local development. Keep them out of
// the public static file handler even if a local deployment directory contains
// one by mistake.
app.use((req, res, next) => {
    if (/^\/(?:oauth-credentials|session-token|database)\.json$/i.test(req.path)
        || /^\/desk\/(?:oauth-credentials|oauth-desktop-credentials|firabase|firebase-auth-config|session-token|database)\.(?:json|js)$/i.test(req.path)) {
        return res.status(404).json({ error: 'Not found' });
    }
    next();
});
app.use(express.static(__dirname));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.get('/', (req, res) => {
    res.send('🚀 Hệ thống Server Cloud của FinderPicture Studio đang hoạt động ổn định!');
});

app.get('/api/health', (req, res) => {
    const ready = isSupabaseConfigured() && Boolean(getOAuthStateSecret()) && Boolean(getTokenEncryptionKey());
    res.status(ready ? 200 : 503).json({
        success: ready,
        requestId: req.requestId,
        storage: isSupabaseConfigured() ? 'supabase' : (REQUIRE_SUPABASE_STORAGE ? 'missing' : 'legacy-local'),
        oauthStateSecret: Boolean(getOAuthStateSecret()),
        tokenEncryptionKey: Boolean(getTokenEncryptionKey()),
        guestCapabilitySecret: Boolean(guestCapabilitySecret()),
        distributedRateLimit: Boolean(isSupabaseConfigured() || (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)),
        rateLimitBackend: isSupabaseConfigured() ? 'supabase' : (process.env.UPSTASH_REDIS_REST_URL ? 'upstash' : 'memory-fallback'),
        rateLimitMetrics: rateLimitMiddleware.getMetrics(),
        directDownloads: Boolean(isSupabaseConfigured() && process.env.FINDER_DIRECT_DOWNLOADS !== '0'),
        downloadStorageBucket: String(process.env.FINDER_DOWNLOAD_BUCKET || 'finder-downloads'),
        thumbnailCache: Boolean(isSupabaseConfigured() && String(process.env.FINDER_THUMBNAIL_CACHE || '1') !== '0'),
        thumbnailStorageBucket: thumbnailStorageBucket(),
        thumbnailTtlDays: thumbnailTtlDays(),
        thumbnailCleanupCron: Boolean(String(process.env.CRON_SECRET || process.env.FINDER_CRON_SECRET || '').trim()),
        alertSink: isSupabaseConfigured() ? 'supabase' : 'none',
        alertWebhook: Boolean(String(process.env.FINDER_ALERT_WEBHOOK || '').trim()),
        alertWebhookFormat: String(process.env.FINDER_ALERT_WEBHOOK_FORMAT || 'generic').trim().toLowerCase()
    });
});

const TOKEN_PATH = path.join(__dirname, 'session-token.json');
const DB_PATH = path.join(__dirname, 'database.json'); 

let likedImagesDatabase = {};
let checkNotesDatabase = {};
let albumCacheDatabase = {}; 
let albumCheckCacheDatabase = {};
let albumSettingsDatabase = {}; 
let albumHistoryDatabase = {};
let bannedAlbums = [];
let finalizedDatabase = {}; 
let firebaseDb = null;
let firebaseMigrationPromise = null;
// Supabase is the primary store when configured. Firebase remains a legacy
// fallback until the migration is explicitly completed and verified.
let supabaseUrl = '';
let supabaseServiceKey = '';
let supabaseLoadPromise = null;

function isSupabaseConfigured() {
    return Boolean(supabaseUrl && supabaseServiceKey);
}

// OAuth callbacks may land on a different serverless instance than the one
// that created the authorization URL. Keep the state stateless: it is a
// short-lived, signed envelope rather than an in-memory Map entry. Set an
// explicit FINDER_OAUTH_STATE_SECRET in Vercel; the credential fallbacks keep
// existing local deployments working while they are being migrated.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
function getOAuthStateSecret() {
    const configured = String(process.env.FINDER_OAUTH_STATE_SECRET || '').trim();
    const fallback = configured
        || supabaseServiceKey
        || String(process.env.GOOGLE_OAUTH_CREDENTIALS || '')
        || String(process.env.FIREBASE_SERVICE_ACCOUNT || '');
    if (!fallback) return null;
    return crypto.createHash('sha256').update(fallback, 'utf8').digest();
}

function createOAuthState() {
    const secret = getOAuthStateSecret();
    if (!secret) throw new Error('OAUTH_STATE_SECRET_NOT_CONFIGURED');
    const payload = {
        v: 1,
        purpose: 'drive',
        issuedAt: Date.now(),
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
        nonce: crypto.randomBytes(24).toString('base64url')
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
}

function verifyOAuthState(state) {
    if (typeof state !== 'string') return false;
    const parts = state.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const secret = getOAuthStateSecret();
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
    let received;
    try { received = Buffer.from(parts[1], 'base64url'); } catch (_) { return false; }
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return false;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const now = Date.now();
        return payload?.v === 1
            && payload?.purpose === 'drive'
            && Number.isFinite(payload.issuedAt)
            && Number.isFinite(payload.expiresAt)
            && payload.expiresAt > now
            && payload.issuedAt <= now + 60_000
            && payload.expiresAt - payload.issuedAt <= OAUTH_STATE_TTL_MS;
    } catch (_) { return false; }
}

// OAuth refresh tokens are encrypted before they enter Supabase/Firebase. A
// dedicated 32-byte hex key can be supplied through FINDER_TOKEN_ENCRYPTION_KEY;
// server-only Supabase/OAuth credentials are compatibility fallbacks so an
// existing deployment does not suddenly lose the ability to refresh Drive.
function getTokenEncryptionKey() {
    const configured = String(process.env.FINDER_TOKEN_ENCRYPTION_KEY || '').trim();
    const source = configured
        || supabaseServiceKey
        || String(process.env.GOOGLE_OAUTH_CREDENTIALS || '')
        || String(process.env.FIREBASE_SERVICE_ACCOUNT || '');
    if (!source) return null;
    if (/^[0-9a-f]{64}$/i.test(source)) return Buffer.from(source, 'hex');
    return crypto.createHash('sha256').update(source, 'utf8').digest();
}

function isEncryptedDriveTokenRecord(value) {
    return Boolean(value && typeof value === 'object' && value._finderEncrypted === true && value.version === 1);
}

function encryptDriveTokenRecord(value) {
    const key = getTokenEncryptionKey();
    if (!key) throw new Error('TOKEN_ENCRYPTION_NOT_CONFIGURED');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return {
        _finderEncrypted: true,
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url')
    };
}

function decryptDriveTokenRecord(value) {
    if (!value) return null;
    // Read legacy plaintext once so it can be transparently re-encrypted on
    // the next server write. New writes never use this branch.
    if (!isEncryptedDriveTokenRecord(value)) return { value, legacy: true };
    const key = getTokenEncryptionKey();
    if (!key) throw new Error('TOKEN_ENCRYPTION_NOT_CONFIGURED');
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(value.ciphertext, 'base64url')),
            decipher.final()
        ]).toString('utf8');
        return { value: JSON.parse(plaintext), legacy: false };
    } catch (_) {
        throw new Error('TOKEN_DECRYPT_FAILED');
    }
}

async function persistDriveTokenRecord(folderId, value) {
    const encrypted = encryptDriveTokenRecord(value);
    if (isSupabaseConfigured()) {
        await supabaseRequest('drive_tokens', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ album_id: String(folderId), token: encrypted, updated_at: new Date().toISOString() })
        });
        return;
    }
    if (firebaseDb) await firebaseDb.ref(`driveTokens/${folderId}`).set(encrypted);
    else throw new Error('TOKEN_STORAGE_NOT_CONFIGURED');
}

async function supabaseRequest(resource, options = {}) {
    if (!isSupabaseConfigured()) return null;
    const response = await fetch(`${supabaseUrl}/rest/v1/${resource}`, {
        ...options,
        headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
}

async function persistApiAlert(entry) {
    if (!isSupabaseConfigured()) return;
    try {
        await supabaseRequest('api_alerts', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
                request_id: entry.requestId || null,
                event: entry.event || 'api.error',
                method: entry.method || null,
                path: entry.path || null,
                status: Number(entry.status) || 0,
                duration_ms: Number(entry.durationMs) || 0,
                ip: entry.ip || null,
                payload: { source: 'finder', alert: true }
            })
        });
    } catch (error) {
        logStructuredEvent('api_alerts.persist_error', { message: error.message });
    }
}

// Large downloads are cached into a private Supabase Storage bucket on the
// first request. Later downloads receive a short-lived signed URL and bypass
// Vercel's response bandwidth entirely. Drive remains the source of truth.
const DOWNLOAD_SIGN_TTL_SECONDS = Math.max(60, Math.min(3600, Number(process.env.FINDER_DOWNLOAD_SIGN_TTL || 900)));
let downloadBucketPromise = null;
let thumbnailBucketPromise = null;
const storageSignedUrlCache = new Map();
const storageObjectMissCache = new Map();
const THUMBNAIL_MISS_TTL_MS = 10 * 60 * 1000;

function thumbnailStorageBucket() {
    return String(process.env.FINDER_THUMBNAIL_BUCKET || 'finder-thumbnails').trim() || 'finder-thumbnails';
}

function thumbnailTtlDays() {
    const configured = Number(process.env.FINDER_THUMBNAIL_TTL_DAYS || 30);
    return Math.max(1, Math.min(365, Number.isFinite(configured) ? configured : 30));
}

function thumbnailSignTtlSeconds() {
    const configured = Number(process.env.FINDER_THUMBNAIL_SIGN_TTL || 86400);
    return Math.max(300, Math.min(30 * 24 * 3600, Number.isFinite(configured) ? configured : 86400));
}

function thumbnailObjectPath(folderId, fileId) {
    const safe = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
    return `v1/${safe(folderId)}/${safe(fileId)}/thumb`;
}

function storageCacheKey(bucket, objectPath) {
    return `${bucket}:${objectPath}`;
}

function getCachedStorageSignedUrl(bucket, objectPath) {
    const key = storageCacheKey(bucket, objectPath);
    const cached = storageSignedUrlCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
        storageSignedUrlCache.delete(key);
        return null;
    }
    return cached.url;
}

function cacheStorageSignedUrl(bucket, objectPath, url, ttlSeconds) {
    const key = storageCacheKey(bucket, objectPath);
    storageSignedUrlCache.set(key, { url, expiresAt: Date.now() + Math.max(60, ttlSeconds - 60) * 1000 });
    if (storageSignedUrlCache.size > 5000) {
        const oldest = storageSignedUrlCache.keys().next().value;
        if (oldest) storageSignedUrlCache.delete(oldest);
    }
}

function isKnownStorageMiss(bucket, objectPath) {
    const key = storageCacheKey(bucket, objectPath);
    const expiresAt = storageObjectMissCache.get(key) || 0;
    if (expiresAt > Date.now()) return true;
    storageObjectMissCache.delete(key);
    return false;
}

function markStorageMiss(bucket, objectPath) {
    storageObjectMissCache.set(storageCacheKey(bucket, objectPath), Date.now() + THUMBNAIL_MISS_TTL_MS);
    if (storageObjectMissCache.size > 5000) {
        const oldest = storageObjectMissCache.keys().next().value;
        if (oldest) storageObjectMissCache.delete(oldest);
    }
}

function clearStorageMiss(bucket, objectPath) {
    storageObjectMissCache.delete(storageCacheKey(bucket, objectPath));
}

function downloadStorageBucket() {
    return String(process.env.FINDER_DOWNLOAD_BUCKET || 'finder-downloads').trim() || 'finder-downloads';
}

function storageObjectPath(folderId, fileId) {
    return `drive/${String(folderId).replace(/[^A-Za-z0-9_-]/g, '_')}/${String(fileId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function encodeStoragePath(objectPath) {
    return objectPath.split('/').map(part => encodeURIComponent(part)).join('/');
}

async function supabaseStorageRequest(resource, options = {}) {
    if (!isSupabaseConfigured()) return null;
    const response = await fetch(`${supabaseUrl}/storage/v1/${resource}`, {
        ...options,
        headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase Storage ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

async function ensureDownloadBucket() {
    if (!isSupabaseConfigured()) return false;
    if (!downloadBucketPromise) {
        downloadBucketPromise = (async () => {
            const bucket = downloadStorageBucket();
            const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
                method: 'POST',
                headers: { apikey: supabaseServiceKey, Authorization: `Bearer ${supabaseServiceKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: bucket, name: bucket, public: false }),
                signal: AbortSignal.timeout(2500)
            });
            if (!response.ok && response.status !== 409) {
                const text = await response.text();
                throw new Error(`Supabase Storage bucket ${response.status}: ${text.slice(0, 300)}`);
            }
            return true;
        })().catch(error => {
            downloadBucketPromise = null;
            logStructuredEvent('download_storage.bucket_error', { message: error.message });
            return false;
        });
    }
    return downloadBucketPromise;
}

async function ensurePrivateStorageBucket(bucketName, stateRef) {
    if (!isSupabaseConfigured()) return false;
    if (!stateRef.promise) {
        stateRef.promise = (async () => {
            const bucket = String(bucketName || '').trim();
            const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
                method: 'POST',
                headers: { apikey: supabaseServiceKey, Authorization: `Bearer ${supabaseServiceKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: bucket, name: bucket, public: false }),
                signal: AbortSignal.timeout(2500)
            });
            if (!response.ok && response.status !== 409) {
                const text = await response.text();
                throw new Error(`Supabase Storage bucket ${response.status}: ${text.slice(0, 300)}`);
            }
            return true;
        })().catch(error => {
            stateRef.promise = null;
            logStructuredEvent('storage.bucket_error', { bucket: bucketName, message: error.message });
            return false;
        });
    }
    return stateRef.promise;
}

async function ensureThumbnailBucket() {
    return ensurePrivateStorageBucket(thumbnailStorageBucket(), { get promise() { return thumbnailBucketPromise; }, set promise(value) { thumbnailBucketPromise = value; } });
}

async function createStorageSignedUrl(bucketName, objectPath, ttlSeconds, fileName) {
    if (!isSupabaseConfigured()) return null;
    const bucket = String(bucketName || '').trim();
    const cached = getCachedStorageSignedUrl(bucket, objectPath);
    if (cached) return cached;
    try {
        const encodedBucket = encodeURIComponent(bucket);
        const data = await supabaseStorageRequest(`object/sign/${encodedBucket}`, {
            method: 'POST',
            body: JSON.stringify({ expiresIn: ttlSeconds, paths: [objectPath] })
        });
        const signedPath = data?.[0]?.signedURL || data?.[0]?.signedUrl || data?.signedURL || data?.signedUrl;
        if (!signedPath) return null;
        const signedUrl = /^https?:\/\//i.test(String(signedPath))
            ? new URL(String(signedPath))
            : new URL(`${supabaseUrl}/storage/v1${String(signedPath).startsWith('/') ? signedPath : `/${signedPath}`}`);
        if (fileName) signedUrl.searchParams.set('download', String(fileName));
        const result = signedUrl.toString();
        cacheStorageSignedUrl(bucket, objectPath, result, ttlSeconds);
        return result;
    } catch (error) {
        // A missing object is expected on its first download; do not turn it
        // into a user-facing error because Drive remains the source of truth.
        logStructuredEvent('storage.sign_miss', { bucket, objectPath, message: error.message });
        return null;
    }
}

async function createDownloadSignedUrl(objectPath, fileName) {
    if (!(await ensureDownloadBucket())) return null;
    return createStorageSignedUrl(downloadStorageBucket(), objectPath, DOWNLOAD_SIGN_TTL_SECONDS, fileName);
}

async function cacheBufferToStorage(bucketName, objectPath, buffer, contentType) {
    if (!isSupabaseConfigured() || !Buffer.isBuffer(buffer) || !buffer.length) return false;
    const bucket = encodeURIComponent(String(bucketName || '').trim());
    const target = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeStoragePath(objectPath)}`;
    const response = await fetch(target, {
        method: 'POST',
        headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            'Content-Type': contentType || 'image/jpeg',
            'x-upsert': 'true',
            'Content-Length': String(buffer.length)
        },
        body: buffer,
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Supabase Storage thumbnail upload ${response.status}: ${(await response.text()).slice(0, 300)}`);
    clearStorageMiss(bucketName, objectPath);
    return true;
}

async function cleanupExpiredThumbnailObjects() {
    if (!(await ensureThumbnailBucket())) return { deleted: 0, scanned: 0, skipped: true };
    const bucket = thumbnailStorageBucket();
    const cutoffMs = Date.now() - thumbnailTtlDays() * 24 * 60 * 60 * 1000;
    const pageSize = 1000;
    const maxObjects = Math.max(100, Math.min(10000, Number(process.env.FINDER_THUMBNAIL_CLEANUP_LIMIT || 2000)));
    const expired = [];
    let offset = 0;
    let scanned = 0;
    while (expired.length < maxObjects) {
        const page = await supabaseStorageRequest(`object/list/${encodeURIComponent(bucket)}`, {
            method: 'POST',
            body: JSON.stringify({ prefix: 'v1/', limit: pageSize, offset, sortBy: { column: 'created_at', order: 'asc' } })
        });
        if (!Array.isArray(page) || !page.length) break;
        scanned += page.length;
        page.forEach(item => {
            const createdAt = Date.parse(String(item?.created_at || ''));
            if (item?.name && Number.isFinite(createdAt) && createdAt < cutoffMs && expired.length < maxObjects) expired.push(String(item.name));
        });
        offset += page.length;
        if (page.length < pageSize) break;
        const timestamps = page.map(item => Date.parse(String(item?.created_at || ''))).filter(Number.isFinite);
        if (timestamps.length && Math.max(...timestamps) >= cutoffMs) break;
    }
    let deleted = 0;
    for (let index = 0; index < expired.length; index += 1000) {
        const batch = expired.slice(index, index + 1000);
        await supabaseStorageRequest(`object/remove/${encodeURIComponent(bucket)}`, {
            method: 'POST',
            body: JSON.stringify({ prefixes: batch })
        });
        deleted += batch.length;
    }
    logStructuredEvent('thumbnail_cache.cleanup', { bucket, ttlDays: thumbnailTtlDays(), scanned, deleted });
    return { bucket, ttlDays: thumbnailTtlDays(), scanned, deleted };
}

function cacheDriveStreamToStorage(stream, file, objectPath) {
    const bucket = encodeURIComponent(downloadStorageBucket());
    const target = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeStoragePath(objectPath)}`;
    return fetch(target, {
        method: 'POST',
        headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            'Content-Type': file.mimeType || 'application/octet-stream',
            'x-upsert': 'true',
            ...(file.size ? { 'Content-Length': String(file.size) } : {})
        },
        body: stream,
        duplex: 'half',
        signal: AbortSignal.timeout(120000)
    }).then(async response => {
        if (!response.ok) throw new Error(`Supabase Storage upload ${response.status}: ${(await response.text()).slice(0, 300)}`);
        return true;
    });
}

function buildSupabaseAlbumRow(folderId) {
    const settings = albumSettingsDatabase[folderId] || {};
    const partition = buildAlbumPartition(folderId);
    return {
        id: String(folderId),
        public_slug: settings.publicSlug ? canonicalPublicSlug(settings.publicSlug) : `album-${String(folderId).slice(-6).toLowerCase()}`,
        gallery_type: settings.galleryType || (settings.partyGallery ? 'party' : 'selection'),
        drive_folder_id: settings.originalFolderId || null,
        original_folder_id: settings.originalFolderId || null,
        settings: stripUndefined(settings),
        state: stripUndefined(partition),
        history: stripUndefined({
            desktop: albumHistoryDatabase[folderId] || null,
            checkHistory: settings.checkHistory || [],
            gallerySections: settings.gallerySections || []
        }),
        is_finalized: Boolean(finalizedDatabase[folderId]),
        workflow_status: settings.workflowStatus || null,
        updated_at: new Date().toISOString()
    };
}

async function persistSupabaseAlbum(folderId) {
    if (!isSupabaseConfigured()) return;
    await supabaseRequest('albums', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(buildSupabaseAlbumRow(folderId))
    });
}

function createManagementToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hasAlbumManagementAccess(req, folderId) {
    const settings = albumSettingsDatabase[folderId];
    // Management routes must fail closed. Previously, legacy albums without a
    // token were treated as authenticated, which allowed anyone who knew an
    // album id to change its settings, status, payment data, or Drive token.
    // New albums receive a token when they are created/first configured; old
    // records must be explicitly bootstrapped before they can be modified.
    const expected = typeof settings?.managementToken === 'string'
        ? settings.managementToken.trim()
        : '';
    if (!expected) return false;

    const supplied = String(req.get('x-finder-management-token') || req.body?.managementToken || '').trim();
    if (!supplied || supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function requireAlbumManagement(req, res, folderId) {
    if (hasAlbumManagementAccess(req, folderId)) return true;
    const settings = albumSettingsDatabase[folderId];
    const code = settings?.managementToken ? 'INVALID_MANAGEMENT_TOKEN' : 'MANAGEMENT_TOKEN_REQUIRED';
    const error = settings?.managementToken
        ? 'Management token không hợp lệ.'
        : 'Album chưa có management token. Hãy mở album bằng desktop để khởi tạo khóa quản lý.';
    res.status(403).json({ success: false, code, error });
    return false;
}

// Public album links still need a browser-bound capability for writes. This is
// not a replacement for Studio authentication; it prevents CSRF and scripts
// on unrelated sites from changing an album just because its slug is known.
// The capability is derived server-side and is never returned in JSON.
function guestCapabilitySecret() {
    return String(process.env.FINDER_GUEST_ACCESS_SECRET || getOAuthStateSecret() || '').trim();
}

function guestCapabilityToken(folderId) {
    const secret = guestCapabilitySecret();
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(`finder-guest:${String(folderId)}`).digest('base64url');
}

function guestCapabilityCookieName(folderId) {
    return `finder_guest_${crypto.createHash('sha256').update(String(folderId)).digest('hex').slice(0, 16)}`;
}

function readRequestCookie(req, name) {
    const cookies = String(req.get('cookie') || '').split(';');
    const prefix = `${name}=`;
    const entry = cookies.find(item => item.trim().startsWith(prefix));
    return entry ? decodeURIComponent(entry.trim().slice(prefix.length)) : '';
}

function issueGuestCapability(res, folderId) {
    const token = guestCapabilityToken(folderId);
    if (!token) return false;
    const production = process.env.NODE_ENV === 'production';
    const sameSite = production ? 'None' : 'Lax';
    const secure = production ? '; Secure' : '';
    res.append('Set-Cookie', `${guestCapabilityCookieName(folderId)}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=${sameSite}${secure}`);
    return true;
}

function hasGuestCapability(req, folderId) {
    const expected = guestCapabilityToken(folderId);
    const supplied = readRequestCookie(req, guestCapabilityCookieName(folderId));
    if (!expected || !supplied || expected.length !== supplied.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function requireGuestCapability(req, res, folderId, { issueOnGet = false } = {}) {
    if (hasGuestCapability(req, folderId)) return true;
    if (issueOnGet && req.method === 'GET') {
        issueGuestCapability(res, folderId);
        return true;
    }
    res.status(403).json({ success: false, code: 'GUEST_CAPABILITY_REQUIRED', requestId: req.requestId, error: 'Phiên xem album không hợp lệ. Hãy mở lại link album rồi thử lại.' });
    return false;
}

function isSafePublicImageName(value) {
    const name = String(value || '').trim();
    return name.length > 0 && name.length <= 255 && path.basename(name) === name && /\.(?:jpe?g|png|webp)$/i.test(name);
}

// Legacy records may not have a token yet. Allow the owner of the connected
// Google Drive account to bootstrap that token once; after it is generated,
// all subsequent calls use the per-album token path above.
async function requireAlbumManagementOrDriveBootstrap(req, res, folderId) {
    if (albumSettingsDatabase[folderId]?.managementToken) return requireAlbumManagement(req, res, folderId);
    const verified = await requireDriveCreationProof(req, res);
    if (verified && albumSettingsDatabase[folderId]) {
        albumSettingsDatabase[folderId].managementToken = createManagementToken();
    }
    return verified;
}

function isDefaultStudioName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return !normalized || normalized === 'finder' || normalized === 'finder studio';
}

function publicAlbumSettings(settings = {}) {
    const { managementToken, ...safeSettings } = settings;
    // Keep the public contract stable for older albums whose settings were
    // written before maxSelections was introduced. A missing value means the
    // album is intentionally unlimited; clients should not have to infer it
    // from an absent JSON property.
    safeSettings.maxSelections = Number.isFinite(Number(safeSettings.maxSelections))
        ? Number(safeSettings.maxSelections)
        : 0;
    safeSettings.studioName = String(safeSettings.studioName || 'FINDER').trim().toUpperCase() || 'FINDER';
    return safeSettings;
}

function firebaseAlbumKey(folderId) {
    return Buffer.from(String(folderId), 'utf8').toString('base64url');
}

function buildAlbumPartition(folderId) {
    return {
        // Keep the logical album id inside the partition. The Firebase key is
        // encoded to support arbitrary ids, so the loader cannot otherwise
        // reconstruct this value after a Vercel cold start.
        folderId: String(folderId),
        likedImages: serializeLikedImages({ [folderId]: likedImagesDatabase[folderId] || {} })[folderId] || {},
        checkNotes: serializeLikedImages({ [folderId]: checkNotesDatabase[folderId] || {} })[folderId] || {},
        settings: albumSettingsDatabase[folderId] || null,
        finalized: Boolean(finalizedDatabase[folderId]),
        banned: bannedAlbums.includes(folderId),
        updatedAt: new Date().toISOString()
    };
}

async function ensureFirebaseMigration() {
    if (!firebaseDb) return;
    if (firebaseMigrationPromise) return firebaseMigrationPromise;
    firebaseMigrationPromise = (async () => {
        const markerRef = firebaseDb.ref('finderPictureStateMigration/v1');
        const markerSnapshot = await markerRef.once('value');
        if (markerSnapshot.exists() && markerSnapshot.val()?.status === 'completed') return;
        const aggregateSnapshot = await firebaseDb.ref('finderPictureState').once('value');
        const aggregate = aggregateSnapshot.val() || {};
        const ids = new Set([
            ...Object.keys(aggregate.likedImagesDatabase || {}),
            ...Object.keys(aggregate.checkNotesDatabase || {}),
            ...Object.keys(aggregate.albumSettingsDatabase || {}),
            ...Object.keys(aggregate.finalizedDatabase || {}),
            ...(Array.isArray(aggregate.bannedAlbums) ? aggregate.bannedAlbums : [])
        ]);
        const backupId = new Date().toISOString().replace(/[:.]/g, '-');
        await firebaseDb.ref(`finderPictureStateBackups/${backupId}`).set({ createdAt: new Date().toISOString(), source: 'finderPictureState', data: aggregate });
        const updates = {};
        for (const folderId of ids) {
            const liked = (aggregate.likedImagesDatabase || {})[folderId] || {};
            const notes = (aggregate.checkNotesDatabase || {})[folderId] || {};
            updates[`finderPictureStateByAlbum/${firebaseAlbumKey(folderId)}`] = {
                folderId,
                likedImages: liked,
                checkNotes: notes,
                settings: (aggregate.albumSettingsDatabase || {})[folderId] || null,
                finalized: Boolean((aggregate.finalizedDatabase || {})[folderId]),
                banned: Array.isArray(aggregate.bannedAlbums) && aggregate.bannedAlbums.includes(folderId),
                updatedAt: new Date().toISOString()
            };
        }
        if (Object.keys(updates).length) await firebaseDb.ref().update(updates);
        await markerRef.set({ status: 'completed', version: 1, backupId, migratedAlbums: ids.size, completedAt: new Date().toISOString() });
    })().catch(error => {
        firebaseMigrationPromise = null;
        console.error('Firebase migration failed:', error.message);
        throw error;
    });
    return firebaseMigrationPromise;
}

// Vercel không giữ được file giữa các lần chạy. Firebase/database.json chỉ là
// compatibility cho local; production luôn buộc phải dùng Supabase.
if (!REQUIRE_SUPABASE_STORAGE) {
    try {
        const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : null;
        const databaseURL = process.env.FIREBASE_DATABASE_URL;
        if (serviceAccount && databaseURL) {
            const firebaseApp = getApps().length
                ? getApps()[0]
                : initializeApp({ credential: cert(serviceAccount), databaseURL });
            firebaseDb = getDatabase(firebaseApp);
        }
    } catch (error) {
        console.error('Không thể khởi tạo Firebase:', error.message);
    }
}

supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
supabaseServiceKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || ''
).trim();
if (isSupabaseConfigured()) console.log('Supabase primary storage đã được cấu hình.');

if (!REQUIRE_SUPABASE_STORAGE && fs.existsSync(DB_PATH)) {
    try { 
        const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); 
        likedImagesDatabase = db.likedImagesDatabase || {};
        checkNotesDatabase = db.checkNotesDatabase || {};
        albumSettingsDatabase = db.albumSettingsDatabase || {};
        bannedAlbums = db.bannedAlbums || [];
        finalizedDatabase = db.finalizedDatabase || {};
    } catch (e) {}
}

function saveDB() {
    if (REQUIRE_SUPABASE_STORAGE) return;
    try { fs.writeFileSync(DB_PATH, JSON.stringify({ likedImagesDatabase, checkNotesDatabase, albumSettingsDatabase, bannedAlbums, finalizedDatabase }), 'utf8'); } catch (e) {}
}

function stripUndefined(value) {
    if (Array.isArray(value)) return value.map(stripUndefined);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item)]));
}

// Settings are updated much more frequently than the rest of an album
// partition. Write only the settings child so a large liked-image partition or
// an aggregate-node update cannot delay the Desktop response.
async function persistAlbumSettings(folderId) {
    if (isSupabaseConfigured()) {
        await persistSupabaseAlbum(folderId);
        return;
    }
    if (REQUIRE_SUPABASE_STORAGE) throw new Error('SUPABASE_REQUIRED');
    if (!firebaseDb) return;
    const key = `finderPictureStateByAlbum/${firebaseAlbumKey(folderId)}`;
    const settings = albumSettingsDatabase[folderId] || null;
    const updates = {
        [`${key}/folderId`]: String(folderId),
        [`${key}/settings`]: stripUndefined(settings),
        [`${key}/updatedAt`]: new Date().toISOString()
    };
    if (settings?.publicSlug) {
        const publicSlug = canonicalPublicSlug(settings.publicSlug);
        updates[`finderPictureSlugIndex/${firebaseAlbumKey(publicSlug)}`] = stripUndefined({
            folderId: String(folderId),
            publicSlug,
            driveFolderId: settings.originalFolderId || null,
            galleryType: settings.galleryType || (settings.partyGallery ? 'party' : 'selection'),
            settings: { ...settings, managementToken: undefined },
            updatedAt: new Date().toISOString()
        });
    }
    await firebaseDb.ref().update(updates);
}

async function loadPersistentState() {
    if (isSupabaseConfigured()) {
        if (supabaseLoadPromise) return supabaseLoadPromise;
        supabaseLoadPromise = (async () => {
            const rows = await supabaseRequest('albums?select=id,public_slug,gallery_type,settings,state,is_finalized,workflow_status,updated_at');
            const liked = {}, notes = {}, settings = {}, finalized = {}, banned = [];
            const history = {};
            for (const row of Array.isArray(rows) ? rows : []) {
                const folderId = String(row?.id || '');
                if (!folderId) continue;
                const partition = row.state && typeof row.state === 'object' ? row.state : {};
                const rowSettings = row.settings && typeof row.settings === 'object' ? { ...row.settings } : {};
                if (!rowSettings.publicSlug && row.public_slug) rowSettings.publicSlug = row.public_slug;
                if (!rowSettings.galleryType && row.gallery_type) rowSettings.galleryType = row.gallery_type;
                if (!rowSettings.originalFolderId && row.original_folder_id) rowSettings.originalFolderId = row.original_folder_id;
                liked[folderId] = deserializeLikedImages({ [folderId]: partition.likedImages || {} })[folderId] || {};
                notes[folderId] = deserializeLikedImages({ [folderId]: partition.checkNotes || {} })[folderId] || {};
                if (Object.keys(rowSettings).length) settings[folderId] = rowSettings;
                if (row.history && typeof row.history === 'object') {
                    history[folderId] = row.history.desktop || (row.history.id ? row.history : null);
                }
                if (row.is_finalized || partition.finalized === true) finalized[folderId] = true;
                if (partition.banned) banned.push(folderId);
            }
            likedImagesDatabase = liked;
            checkNotesDatabase = notes;
            albumSettingsDatabase = settings;
            albumHistoryDatabase = history;
            finalizedDatabase = finalized;
            bannedAlbums = banned;
        })().finally(() => { supabaseLoadPromise = null; });
        return supabaseLoadPromise;
    }
    if (REQUIRE_SUPABASE_STORAGE) throw new Error('SUPABASE_REQUIRED');
    if (!firebaseDb) return;
    await ensureFirebaseMigration();
    // Read album partitions first. The old aggregate node is retained as a
    // migration/rollback source and only used for legacy fallback.
    const partitionsSnapshot = await firebaseDb.ref('finderPictureStateByAlbum').once('value');
    const partitions = partitionsSnapshot.val();
    if (partitions && Object.keys(partitions).length) {
        const liked = {}, notes = {}, settings = {}, finalized = {}, banned = [];
        for (const [encodedKey, partition] of Object.entries(partitions)) {
            // Partitions written by an earlier build did not store folderId;
            // decode their base64url Firebase key so existing albums remain
            // readable instead of silently falling back to empty state.
            let folderId = String(partition?.folderId || '');
            if (!folderId) {
                try { folderId = Buffer.from(String(encodedKey), 'base64url').toString('utf8'); } catch (_) {}
            }
            if (!folderId) continue;
            liked[folderId] = deserializeLikedImages({ [folderId]: partition.likedImages || {} })[folderId] || {};
            notes[folderId] = deserializeLikedImages({ [folderId]: partition.checkNotes || {} })[folderId] || {};
            if (partition.settings) settings[folderId] = partition.settings;
            if (partition.finalized) finalized[folderId] = true;
            if (partition.banned) banned.push(folderId);
        }
        likedImagesDatabase = liked;
        checkNotesDatabase = notes;
        albumSettingsDatabase = settings;
        finalizedDatabase = finalized;
        bannedAlbums = banned;
        return;
    }
    const snapshot = await firebaseDb.ref('finderPictureState').once('value');
    const state = snapshot.val();
    if (!state) return;
    likedImagesDatabase = deserializeLikedImages(state.likedImagesDatabase || {});
    checkNotesDatabase = deserializeLikedImages(state.checkNotesDatabase || {});
    albumSettingsDatabase = state.albumSettingsDatabase || {};
    bannedAlbums = state.bannedAlbums || [];
    finalizedDatabase = state.finalizedDatabase || {};
}

// Firebase Realtime Database cấm . # $ / [ ] trong key. Tên file ảnh thường
// có dấu chấm (ví dụ EOSR4592.JPG), nên chỉ mã hóa key khi ghi lên Firebase.
function serializeLikedImages(likedImages) {
    return Object.fromEntries(Object.entries(likedImages).map(([folderId, files]) => [
        folderId,
        Object.fromEntries(Object.entries(files || {}).map(([fileName, value]) => [
            `file_${Buffer.from(fileName, 'utf8').toString('base64url')}`,
            value
        ]))
    ]));
}

function deserializeLikedImages(likedImages) {
    return Object.fromEntries(Object.entries(likedImages).map(([folderId, files]) => [
        folderId,
        Object.fromEntries(Object.entries(files || {}).map(([storedKey, value]) => {
            if (!storedKey.startsWith('file_')) return [storedKey, value];
            try {
                return [Buffer.from(storedKey.slice(5), 'base64url').toString('utf8'), value];
            } catch (error) {
                return [storedKey, value];
            }
        }))
    ]));
}

async function persistState(changedFolderId = null, options = {}) {
    saveDB();
    if (isSupabaseConfigured()) {
        if (options.clearAll) {
            await supabaseRequest('albums', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            return;
        }
        if (changedFolderId) {
            if (options.deletePartition) {
                await supabaseRequest(`albums?id=eq.${encodeURIComponent(changedFolderId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            } else {
                await persistSupabaseAlbum(changedFolderId);
            }
        }
        return;
    }
    if (REQUIRE_SUPABASE_STORAGE) throw new Error('SUPABASE_REQUIRED');
    if (firebaseDb) {
        // Keep the aggregate node immutable as a migration/rollback snapshot.
        // All normal writes go to one album partition, preventing unrelated
        // albums from rewriting a large Firebase node.
        const updates = { 'finderPictureStateMeta/bannedAlbums': bannedAlbums };
        if (changedFolderId) {
            const key = `finderPictureStateByAlbum/${firebaseAlbumKey(changedFolderId)}`;
            const settings = albumSettingsDatabase[changedFolderId] || null;
            updates[key] = options.deletePartition ? null : buildAlbumPartition(changedFolderId);
            // Keep a small, durable public-link index. The album settings are
            // partitioned by the internal id, while clients enter the stable
            // slug; indexing both prevents a valid Gallery/PSC link becoming
            // a false 404 after a serverless instance is recycled.
            if (!options.deletePartition && settings?.publicSlug) {
                const publicSlug = canonicalPublicSlug(settings.publicSlug);
                updates[`finderPictureSlugIndex/${firebaseAlbumKey(publicSlug)}`] = stripUndefined({
                    folderId: String(changedFolderId),
                    publicSlug,
                    driveFolderId: settings.originalFolderId || null,
                    galleryType: settings.galleryType || (settings.partyGallery ? 'party' : 'selection'),
                    settings: { ...settings, managementToken: undefined },
                    updatedAt: new Date().toISOString()
                });
            }
        } else if (options.clearAll) {
            updates.finderPictureStateByAlbum = null;
            updates.finderPictureSlugIndex = null;
        }
        await firebaseDb.ref().update(updates);
    }
}

function getOAuth2Client() {
    const redirectUri = 'http://localhost:3000/oauth2callback';
    // 1. Ưu tiên đọc từ biến môi trường trên Vercel (Bảo mật cao nhất)
    if (process.env.GOOGLE_OAUTH_CREDENTIALS) {
        try {
            const credentials = JSON.parse(process.env.GOOGLE_OAUTH_CREDENTIALS);
            const { client_id, client_secret } = credentials.installed || credentials.web;
            return new google.auth.OAuth2(client_id, client_secret, redirectUri);
        } catch (e) {
            console.error("Lỗi định dạng GOOGLE_OAUTH_CREDENTIALS");
        }
    }
    
    // 2. Fallback đọc file local nếu chạy trên máy tính của bạn
    const credentialsPath = path.join(__dirname, 'oauth-credentials.json');
    if (!fs.existsSync(credentialsPath)) return null;
    const content = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(content);
    const { client_id, client_secret } = credentials.installed || credentials.web;
    return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

app.post('/api/auth/drive-authorize', (req, res) => {
    try {
        const client = getOAuth2Client();
        if (!client) return res.status(503).json({ error: 'Server chưa cấu hình GOOGLE_OAUTH_CREDENTIALS.' });
        const state = createOAuthState();
        // Do not force Google's consent page on every recovery attempt. The
        // first grant still returns an offline refresh token; later attempts
        // only select the account unless Google genuinely needs consent again.
        res.json({ success: true, clientId: client._clientId, authUrl: client.generateAuthUrl({ access_type:'offline', prompt:'select_account', state, scope:['https://www.googleapis.com/auth/drive'] }) });
    } catch (error) {
        if (error.message === 'OAUTH_STATE_SECRET_NOT_CONFIGURED') {
            return res.status(503).json({ code: error.message, error: 'Server chưa cấu hình FINDER_OAUTH_STATE_SECRET.' });
        }
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/auth/drive-client', (req, res) => {
    try { const client = getOAuth2Client(); if (!client) return res.status(503).json({ error:'Server chưa cấu hình OAuth.' }); res.json({ success:true, clientId:client._clientId }); }
    catch (error) { res.status(500).json({ error:error.message }); }
});

// Refresh access tokens on the server, where the OAuth client secret is
// available. Desktop builds intentionally do not contain that secret.
app.post('/api/auth/drive-refresh', async (req, res) => {
    try {
        const refreshToken = req.body?.refreshToken;
        const client = getOAuth2Client();
        if (!client || !refreshToken) return res.status(400).json({ error: 'Thiếu cấu hình OAuth hoặc refresh token.' });
        client.setCredentials({ refresh_token: refreshToken });
        const result = await client.getAccessToken();
        if (!result?.token) return res.status(401).json({ error: 'Không thể làm mới phiên Google Drive.' });
        res.json({ success: true, access_token: result.token, expiry_date: Date.now() + 3600000 });
    } catch (error) { res.status(401).json({ error: error.message }); }
});

// Desktop clients call this endpoint before opening Google's consent page.  It
// was previously missing, so every 404 was treated as an expired session and
// opened a new Google sign-in window on every folder-picker click.
app.get('/api/auth/drive-token', (req, res) => {
    try {
        const client = getOAuth2Client();
        if (!client) return res.status(503).json({ error: 'Server chưa cấu hình OAuth.' });
        const tokens = getStoredTokens();
        // Không phát refresh/access token dùng chung cho mọi máy. Desktop mới
        // sẽ tự OAuth theo máy; chỉ bật cơ chế cũ trong môi trường thử nghiệm
        // khi explicitly đặt biến môi trường.
        const allowSharedToken = process.env.FINDER_ALLOW_SHARED_TOKEN_API === '1';
        res.json({ success: true, clientId: client._clientId, tokens: allowSharedToken ? (tokens || null) : null, tokenAvailable: Boolean(tokens) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/client.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
});

async function findStudioHistoryBySlug(requested) {
    if (!firebaseDb) return null;
    try {
        const snapshot = await firebaseDb.ref('studioAlbumHistory').once('value');
        const studios = snapshot.val() || {};
        for (const albums of Object.values(studios)) {
            for (const album of Object.values(albums || {})) {
                const candidate = album?.publicSlug || String(album?.link || '').match(/\/a\/([^/?#]+)/)?.[1];
                if (candidate && canonicalPublicSlug(candidate) === requested) return album;
            }
        }
    } catch (error) {
        console.warn('Không đọc được lịch sử studio để resolve slug:', error.message);
    }
    return null;
}

// Legacy desktop builds generated public links from the local folder name and
// the last six characters of the Drive folder id, but an interrupted settings
// write could leave no Firebase slug mapping. Resolve that link directly from
// Drive as a compatibility fallback. This path is only used after the normal
// Firebase lookup fails, so normal client requests remain cheap.
async function findDriveFolderByLegacySlug(requested, rawSlug) {
    const raw = String(rawSlug || '').trim();
    const rawTail = raw.includes('-') ? raw.slice(raw.lastIndexOf('-') + 1) : '';
    const tail = canonicalPublicSlug(rawTail);
    if (tail.length < 4) return null;
    const baseSlug = canonicalPublicSlug(raw.includes('-') ? raw.slice(0, raw.lastIndexOf('-')) : '');
    // The desktop stores a per-album OAuth token in Firebase. When the folder
    // is not visible in the service account's Drive corpus, use that index to
    // recover the exact id without asking the user to upload again.
    if (firebaseDb) {
        try {
            const tokenSnapshot = await firebaseDb.ref('driveTokens').once('value');
            const tokenEntries = Object.entries(tokenSnapshot.val() || {});
            for (const [folderId, storedTokens] of tokenEntries) {
                const tokenRootId = normalizeDriveFolderId(storedTokens?._finderMeta?.driveFolderId, '');
                const matchesTail = [folderId, tokenRootId].some(id => id && id.slice(-6).toLowerCase() === rawTail.toLowerCase());
                if (!matchesTail && !tokenRootId) continue;
                try {
                    const auth = await getAlbumDriveAuth(folderId);
                    if (!auth) continue;
                    const drive = google.drive({ version: 'v3', auth });
                    const driveFolderId = normalizeDriveFolderId(auth.finderDriveFolderId, tokenRootId || folderId);
                    const metadata = await drive.files.get({ fileId: driveFolderId, fields: 'id,name,mimeType,appProperties', supportsAllDrives: true });
                    const nameSlug = canonicalPublicSlug(metadata.data.name || '');
                    if (!baseSlug || nameSlug === baseSlug) return {
                        folderId: driveFolderId,
                        albumFolderId: folderId,
                        driveFolderId,
                        folderName: metadata.data.name || 'Album khách hàng',
                        appProperties: metadata.data.appProperties || {},
                        galleryType: auth.finderGalleryType || storedTokens?._finderMeta?.galleryType || 'selection',
                        gallerySections: auth.finderGallerySections || storedTokens?._finderMeta?.gallerySections || []
                    };
                } catch (error) {
                    console.warn('Không thể đọc folder Drive từ token album:', error.message);
                }
            }
        } catch (error) {
            console.warn('Không thể đọc chỉ mục driveTokens:', error.message);
        }
    }
    const authCandidates = [];
    const serviceAuth = getServiceAccountAuth();
    if (serviceAuth) authCandidates.push(serviceAuth);
    try {
        const tokens = getStoredTokens();
        const client = getOAuth2Client();
        if (tokens && client) { client.setCredentials(tokens); authCandidates.push(client); }
    } catch (_) {}
    for (const auth of authCandidates) {
        try {
            const drive = google.drive({ version: 'v3', auth });
            let pageToken;
            do {
                const response = await drive.files.list({
                    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
                    fields: 'nextPageToken,files(id,name,parents,appProperties)',
                    pageSize: 1000,
                    pageToken,
                    corpora: 'allDrives',
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true
                });
                for (const folder of response.data.files || []) {
                    const id = String(folder.id || '');
                    const idTail = id.slice(-6).toLowerCase();
                    const nameSlug = canonicalPublicSlug(folder.name || '');
                    if (!id || (idTail !== rawTail.toLowerCase() && canonicalPublicSlug(idTail) !== tail)) continue;
                    if (baseSlug && nameSlug !== baseSlug) continue;
                    return { folderId: id, folderName: folder.name || 'Album khách hàng', appProperties: folder.appProperties || {} };
                }
                pageToken = response.data.nextPageToken || undefined;
            } while (pageToken);
        } catch (error) {
            console.warn('Không thể tìm Drive bằng một credential:', error.message);
        }
    }
    return null;
}

app.get('/api/album-by-slug/:slug', async (req, res) => {
    await loadPersistentState();
    const requested = canonicalPublicSlug(req.params.slug);
    let match = Object.entries(albumSettingsDatabase).find(([, settings]) => canonicalPublicSlug(settings?.publicSlug) === requested);
    // If an older upload never saved its custom name, the old desktop link
    // still contains the final Drive-id fragment while the server-generated
    // fallback is `album-<fragment>`. Accept that safe, unique legacy form.
    if (!match) {
        const tail = requested.split('-').pop() || '';
        const candidates = Object.entries(albumSettingsDatabase).filter(([folderId, settings]) =>
            tail.length >= 4
            && canonicalPublicSlug(settings?.publicSlug) === `album-${tail}`
            && canonicalPublicSlug(folderId).endsWith(tail)
        );
        if (candidates.length === 1) match = candidates[0];
    }
    // Gallery links created by older desktop builds could contain a stale
    // six-character Drive suffix after the customer folder was recreated.
    // If the readable customer slug is unique, keep that link alive and let
    // the album endpoint resolve the current Drive root from its settings.
    if (!match) {
        const requestedBase = requested.slice(0, requested.lastIndexOf('-'));
        if (requestedBase) {
            const candidates = Object.entries(albumSettingsDatabase).filter(([, settings]) => {
                const candidate = canonicalPublicSlug(settings?.publicSlug || '');
                const candidateBase = candidate.slice(0, candidate.lastIndexOf('-'));
                return candidateBase === requestedBase && settings?.galleryType === 'party';
            });
            if (candidates.length === 1) match = candidates[0];
        }
    }
    if (!match) {
        const history = await findStudioHistoryBySlug(requested);
        const folderId = String(history?.id || history?.folderId || '');
        if (history && folderId) {
            // Some older desktop builds wrote the local studio history even
            // when the settings request was rejected by an existing token.
            // Rehydrate the minimum public settings so that the already sent
            // client link remains usable instead of returning a false 404.
            const restored = {
                isEnabled: history.watermarkToggle !== false,
                text: history.watermarkText || 'FINDERPICTURE STUDIO',
                maxSelections: Number(history.maxSelections) || 0,
                publicSlug: requested,
                clientName: history.clientName || history.name || 'Album khách hàng',
                displayName: history.displayName || 'Finder',
                originalFolderId: history.originalFolderId || null,
                studioName: String(history.studioName || 'Finder').trim().toUpperCase(),
                studioLogo: history.studioLogo || '',
                accentColor: history.accentColor || '#7c8cff',
                galleryType: history.galleryType,
                partyGallery: history.partyGallery,
                gallerySections: history.gallerySections,
                checkFolderId: history.checkFolderId || null,
                checkVersion: Number(history.checkVersion) || 0,
                checkReady: Boolean(history.checkReady),
                workflowStatus: history.workflowStatus || 'selection_open'
            };
            albumSettingsDatabase[folderId] = { ...(albumSettingsDatabase[folderId] || {}), ...restored };
            try { await persistState(folderId); } catch (error) { console.warn('Không thể khôi phục settings album từ lịch sử:', error.message); }
            match = [folderId, albumSettingsDatabase[folderId]];
        }
    }
    // Resolve from the durable slug index before attempting the legacy Drive
    // scan. This is especially important for Gallery/PSC albums whose internal
    // id is a party UUID, not the customer Drive folder id encoded in the URL.
    if (!match && firebaseDb) {
        try {
            const indexSnapshot = await firebaseDb.ref(`finderPictureSlugIndex/${firebaseAlbumKey(requested)}`).once('value');
            const indexed = indexSnapshot.val();
            const indexedFolderId = String(indexed?.folderId || '');
            if (indexedFolderId) {
                const indexedSettings = indexed.settings || {};
                albumSettingsDatabase[indexedFolderId] = {
                    ...(albumSettingsDatabase[indexedFolderId] || {}),
                    ...indexedSettings,
                    publicSlug: requested,
                    originalFolderId: indexedSettings.originalFolderId || indexed.driveFolderId || null,
                    galleryType: indexedSettings.galleryType || indexed.galleryType || 'selection',
                    partyGallery: indexedSettings.partyGallery || indexed.galleryType === 'party'
                };
                match = [indexedFolderId, albumSettingsDatabase[indexedFolderId]];
            }
        } catch (error) {
            console.warn('Không thể đọc chỉ mục public slug:', error.message);
        }
    }
    // Older records may predate the slug index. Read the partition directly as
    // a one-time compatibility lookup so a valid stored publicSlug is enough
    // to recover the album even when the in-memory cache was cold.
    if (!match && firebaseDb) {
        try {
            const partitions = (await firebaseDb.ref('finderPictureStateByAlbum').once('value')).val() || {};
            for (const partition of Object.values(partitions)) {
                const candidate = partition?.settings?.publicSlug;
                if (!candidate || canonicalPublicSlug(candidate) !== requested) continue;
                const folderId = String(partition.folderId || '');
                if (!folderId) continue;
                albumSettingsDatabase[folderId] = { ...(albumSettingsDatabase[folderId] || {}), ...partition.settings };
                match = [folderId, albumSettingsDatabase[folderId]];
                break;
            }
        } catch (error) {
            console.warn('Không thể đọc partition để khôi phục public slug:', error.message);
        }
    }
    if (!match) {
        try {
            const recovered = await findDriveFolderByLegacySlug(requested, req.params.slug);
            if (recovered) {
                const folderId = recovered.albumFolderId || recovered.folderId;
                const restored = {
                    isEnabled: true,
                    text: 'FINDERPICTURE STUDIO',
                    maxSelections: 0,
                    publicSlug: requested,
                    clientName: recovered.folderName,
                    displayName: 'Finder',
                    originalFolderId: recovered.driveFolderId || recovered.folderId || null,
                    studioName: recovered.appProperties?.finderStudioName || 'FINDER',
                    studioLogo: '',
                    accentColor: '#7c8cff',
                    checkReady: false,
                    checkVersion: 0,
                    checkNeedsRevision: false,
                    workflowStatus: recovered.galleryType === 'party' ? 'completed' : 'selection_open',
                    galleryType: recovered.galleryType,
                    partyGallery: recovered.galleryType === 'party',
                    gallerySections: recovered.gallerySections || []
                };
                albumSettingsDatabase[folderId] = { ...(albumSettingsDatabase[folderId] || {}), ...restored };
                if (recovered.galleryType === 'party') finalizedDatabase[folderId] = true;
                // Do not hold the client response on a best-effort Firebase
                // repair. The next request will use the persisted partition if
                // the write succeeds; otherwise this resolver can recover it
                // again from Drive without returning a false 404.
                persistState(folderId).catch(error => console.warn('Không thể lưu slug legacy từ Drive:', error.message));
                match = [folderId, albumSettingsDatabase[folderId]];
            }
        } catch (error) {
            console.warn('Không thể tìm thư mục Drive theo slug legacy:', error.message);
        }
    }
    if (!match) return res.status(404).json({ success: false, error: 'Không tìm thấy album với đường dẫn này.' });
    let resolvedSettings = { ...match[1] };
    if (!resolvedSettings.studioName || /^finder( studio)?$/i.test(String(resolvedSettings.studioName).trim())) {
        const driveStudioName = await readDriveBranding(await getAlbumDriveClient(match[0]), match[0]);
        if (driveStudioName) resolvedSettings.studioName = driveStudioName;
    }
    const settings = { ...resolvedSettings, publicSlug: requested };
    issueGuestCapability(res, match[0]);
    res.json({ success: true, folderId: match[0], settings: publicAlbumSettings(settings) });
});

// Social crawlers (Messenger/Zalo) do not execute the client JavaScript. Add
// server-rendered Open Graph values so a shared album is presented as Finder
// instead of an opaque URL. The gallery page itself remains unchanged.
app.get('/a/:slug', async (req, res) => {
    try {
        await loadPersistentState();
        const requested = canonicalPublicSlug(req.params.slug);
        const matchEntry = Object.entries(albumSettingsDatabase).find(([, settings]) => canonicalPublicSlug(settings?.publicSlug) === requested);
        const match = matchEntry?.[1] || null;
        const title = 'Finder - Ứng dụng bàn giao và chọn ảnh';
        const description = match?.galleryType === 'party' ? 'Gallery ảnh tiệc / PSC trên Finder' : 'Gallery ảnh khách hàng trên Finder';
        const source = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
        const canonicalUrl = `https://${process.env.ONLINE_DOMAIN || 'finder-swart-pi.vercel.app'}/a/${encodeURIComponent(req.params.slug)}`;
        const meta = `<meta name="description" content="${escapeHtmlAttribute(title)}"><meta property="og:title" content="${escapeHtmlAttribute(title)}"><meta property="og:description" content="${escapeHtmlAttribute(description)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Finder"><meta property="og:url" content="${escapeHtmlAttribute(canonicalUrl)}"><meta property="og:locale" content="vi_VN"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtmlAttribute(title)}"><meta name="twitter:description" content="${escapeHtmlAttribute(description)}">`;
        const withoutStaticSocialMeta = source
            .replace(/\s*<meta property="og:[^"]+" content="[^"]*">/g, '')
            .replace(/\s*<meta name="twitter:[^"]+" content="[^"]*">/g, '')
            .replace(/\s*<meta name="description" content="[^"]*">/g, '');
        const withSocialTitle = withoutStaticSocialMeta.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtmlAttribute(title)}</title>`);
        // The slug resolver already found the internal album id while
        // preparing this HTML shell. Bootstrap that safe public id into the
        // client so it can start the Drive request immediately instead of
        // making a second `/api/album-by-slug` round-trip.
        const bootstrap = matchEntry ? { folderId: matchEntry[0], publicSlug: requested } : null;
        const bootstrapScript = bootstrap
            ? `<script>window.__FINDER_ALBUM_BOOTSTRAP__=${JSON.stringify(bootstrap).replace(/</g, '\\u003c')};</script>`
            : '';
        res.set('Cache-Control', 'public, max-age=30, s-maxage=300, stale-while-revalidate=3600');
        return res.type('html').send(withSocialTitle.replace('</head>', `${meta}${bootstrapScript}</head>`));
    } catch (_) {
        return res.sendFile(path.join(__dirname, 'client.html'));
    }
});

app.post('/api/auth/drive-exchange', async (req, res) => {
    const { code, state } = req.body || {};
    if (!code || !verifyOAuthState(state)) return res.status(400).json({ code: 'OAUTH_STATE_INVALID', error: 'Yêu cầu OAuth không hợp lệ hoặc đã hết hạn.' });
    try { const client = getOAuth2Client(); const result = await client.getToken(code); res.json({ success:true, tokens:result.tokens, clientId:client._clientId }); }
    catch (error) { res.status(400).json({ error: error.message }); }
});

function getServiceAccountAuth() {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) return null;
    try {
        const account = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
        if (!account.client_email || !account.private_key) return null;
        return new google.auth.JWT({
            email: account.client_email,
            key: account.private_key.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });
    } catch (error) { console.error('Lỗi GOOGLE_SERVICE_ACCOUNT:', error.message); return null; }
}

async function getAlbumDriveAuth(folderId) {
    let storedRecord = null;
    if (isSupabaseConfigured()) {
        const rows = await supabaseRequest(`drive_tokens?album_id=eq.${encodeURIComponent(folderId)}&select=token`);
        storedRecord = rows?.[0]?.token || null;
    } else {
        if (!firebaseDb) return null;
        const snapshot = await firebaseDb.ref(`driveTokens/${folderId}`).once('value');
        storedRecord = snapshot.val();
    }
    const decrypted = decryptDriveTokenRecord(storedRecord);
    const stored = decrypted?.value || null;
    const metadata = stored?._finderMeta || {};
    const tokens = stored ? { ...stored } : null;
    if (tokens) delete tokens._finderMeta;
    if (!tokens?.refresh_token && !tokens?.access_token) return null;
    // Migrate legacy plaintext records after a successful decrypt. The raw
    // token exists only in memory during this request and is never logged.
    if (decrypted?.legacy) {
        try { await persistDriveTokenRecord(folderId, stored); } catch (error) { console.warn('Không thể mã hóa token Drive cũ:', error.message); }
    }
    const credentials = process.env.GOOGLE_OAUTH_CREDENTIALS;
    if (!credentials) return null;
    const cfg = JSON.parse(credentials); const c = cfg.web || cfg.installed;
    const client = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://localhost:3000/oauth2callback');
    client.setCredentials(tokens);
    if (tokens.refresh_token && (!tokens.expiry_date || tokens.expiry_date < Date.now() + 60000)) {
        const refreshed = await client.getAccessToken();
        if (refreshed?.token) {
            // Keep the Drive-root metadata when rotating an expired token;
            // without it a cold Vercel instance falls back to the internal
            // `party-...` id and the gallery can no longer be resolved.
            const next = { ...tokens, access_token: refreshed.token, expiry_date: Date.now() + 3600000, ...(Object.keys(metadata).length ? { _finderMeta: metadata } : {}) };
            await persistDriveTokenRecord(folderId, next);
            client.setCredentials(next);
        }
    }
    if (metadata.driveFolderId) client.finderDriveFolderId = metadata.driveFolderId;
    if (metadata.galleryType) client.finderGalleryType = metadata.galleryType;
    if (Array.isArray(metadata.gallerySections)) client.finderGallerySections = metadata.gallerySections;
    return client;
}

async function getAlbumDriveClient(folderId) {
    const oauth = await getAlbumDriveAuth(folderId);
    if (oauth) return google.drive({ version: 'v3', auth: oauth });
    const serviceAccount = getServiceAccountAuth();
    return serviceAccount ? google.drive({ version: 'v3', auth: serviceAccount }) : null;
}

async function readDriveBranding(drive, folderId) {
    if (!drive) return null;
    try {
        const response = await drive.files.get({ fileId: folderId, fields: 'id,appProperties', supportsAllDrives: true });
        const value = response.data?.appProperties?.finderStudioName;
        return value ? String(value).trim().toUpperCase() : null;
    } catch (_) {
        return null;
    }
}

// Recover the Drive root for older Gallery/PSC records whose Firebase
// settings were not written. The public slug contains the customer folder
// name and the last six characters of that Drive id.
async function recoverDriveStructureBySlug(drive, slug) {
    if (!drive || !slug) return null;
    const raw = String(slug).trim();
    const separator = raw.lastIndexOf('-');
    const tail = separator >= 0 ? canonicalPublicSlug(raw.slice(separator + 1)) : '';
    const baseName = canonicalPublicSlug(separator >= 0 ? raw.slice(0, separator) : raw);
    if (!tail || tail.length < 4 || !baseName) return null;
    let root;
    let pageToken;
    do {
        const response = await drive.files.list({
            q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: 'nextPageToken,files(id,name)', pageSize: 1000, pageToken,
            includeItemsFromAllDrives: true, supportsAllDrives: true
        });
        root = (response.data.files || []).find(folder =>
            canonicalPublicSlug(folder.name || '') === baseName
            && canonicalPublicSlug(String(folder.id || '').slice(-6)) === tail
        );
        pageToken = root ? undefined : (response.data.nextPageToken || undefined);
    } while (!root && pageToken);
    if (!root?.id) return null;
    const childResponse = await drive.files.list({
        q: `'${root.id}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    const children = childResponse.data.files || [];
    const original = children.find(item => item.mimeType === 'application/vnd.google-apps.folder' && String(item.name || '').toUpperCase() === 'ORIGINAL');
    if (original?.id) {
        return { folderId: root.id, folderName: root.name || 'Album khách hàng', galleryType: 'selection', originalFolderId: original.id, gallerySections: [] };
    }
    const sections = children
        .filter(item => item.mimeType === 'application/vnd.google-apps.folder' && item.id)
        .map(item => ({ id: item.id, name: item.name || 'Ngày', driveFolderId: item.id }));
    return {
        folderId: root.id,
        folderName: root.name || 'Gallery tiệc',
        galleryType: 'party',
        originalFolderId: root.id,
        gallerySections: sections.length ? sections : [{ id: root.id, name: 'Tất cả', driveFolderId: root.id }]
    };
}

// Prefer the Drive root saved alongside the OAuth token. This is both faster
// and more reliable than scanning every folder in Drive, especially for party
// galleries whose Firebase settings may be missing after a serverless cold
// start. The root id is never the internal `party-...` album id.
async function recoverDriveStructureFromRoot(drive, rootId) {
    const safeRootId = normalizeDriveFolderId(rootId, '');
    if (!drive || !safeRootId) return null;
    const rootResponse = await drive.files.get({
        fileId: safeRootId,
        fields: 'id,name,mimeType',
        supportsAllDrives: true
    });
    const root = rootResponse.data;
    if (!root?.id || root.mimeType !== 'application/vnd.google-apps.folder') return null;
    const childResponse = await drive.files.list({
        q: `'${root.id}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    });
    const children = childResponse.data.files || [];
    const original = children.find(item => item.mimeType === 'application/vnd.google-apps.folder' && String(item.name || '').toUpperCase() === 'ORIGINAL');
    if (original?.id) {
        return { folderId: root.id, folderName: root.name || 'Album khách hàng', galleryType: 'selection', originalFolderId: original.id, gallerySections: [] };
    }
    const sections = children
        .filter(item => item.mimeType === 'application/vnd.google-apps.folder' && item.id)
        .map(item => ({ id: item.id, name: item.name || 'Ngày', driveFolderId: item.id }));
    return {
        folderId: root.id,
        folderName: root.name || 'Gallery tiệc',
        galleryType: 'party',
        originalFolderId: root.id,
        gallerySections: sections.length ? sections : [{ id: root.id, name: 'Tất cả', driveFolderId: root.id }]
    };
}

async function saveDriveBranding(folderId, studioName) {
    const drive = await getAlbumDriveClient(folderId);
    if (!drive) return false;
    const value = String(studioName || 'Finder').trim().toUpperCase() || 'FINDER';
    await drive.files.update({
        fileId: folderId,
        requestBody: { appProperties: { finderStudioName: value } },
        fields: 'id,appProperties',
        supportsAllDrives: true
    });
    return true;
}

// Endpoint không lộ bí mật, dùng sau khi deploy để phân biệt lỗi
// cấu hình cloud với lỗi quyền truy cập từng folder Drive.
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        firebaseConfigured: Boolean(firebaseDb),
        supabaseConfigured: isSupabaseConfigured(),
        googleDriveServiceAccountConfigured: Boolean(getServiceAccountAuth())
    });
});

// ĐOẠN QUAN TRỌNG NHẤT ĐỂ CHẠY TRÊN VERCEL
function getStoredTokens() {
    if (process.env.GOOGLE_SESSION_TOKEN) {
        try {
            return JSON.parse(process.env.GOOGLE_SESSION_TOKEN);
        } catch (e) {
            console.error("Lỗi định dạng GOOGLE_SESSION_TOKEN");
        }
    }
    if (fs.existsSync(TOKEN_PATH)) {
        return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    }
    return null;
}

// A new album has no management token yet. For that one creation request only,
// require proof that the caller controls the Google Drive account used for the
// upload. The short-lived access token is verified with Drive and is never
// persisted or returned to the client.
async function requireDriveCreationProof(req, res) {
    const accessToken = String(req.get('x-finder-drive-access-token') || '').trim();
    if (!accessToken) {
        res.status(403).json({ success: false, code: 'DRIVE_AUTH_REQUIRED', error: 'Cần kết nối Google Drive trước khi tạo album.' });
        return false;
    }
    const client = getOAuth2Client();
    if (!client) {
        res.status(503).json({ success: false, code: 'DRIVE_OAUTH_NOT_CONFIGURED', error: 'Máy chủ chưa cấu hình Google Drive OAuth.' });
        return false;
    }
    try {
        client.setCredentials({ access_token: accessToken });
        await google.drive({ version: 'v3', auth: client }).about.get({ fields: 'user(emailAddress)' });
        return true;
    } catch (error) {
        console.warn('Drive creation proof failed:', JSON.stringify({ code: error.code, message: error.message }));
        res.status(403).json({ success: false, code: 'DRIVE_AUTH_INVALID', error: 'Phiên Google Drive không hợp lệ hoặc đã hết hạn.' });
        return false;
    }
}

app.post('/api/album/:folderId/settings', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    // The first desktop upload creates the album settings and receives the
    // freshly generated management token in the response. Once settings
    // exist, the same endpoint is an update and must be authenticated.
    const hasExistingSettings = Object.prototype.hasOwnProperty.call(albumSettingsDatabase, folderId);
    if (hasExistingSettings) {
        if (!(await requireAlbumManagementOrDriveBootstrap(req, res, folderId))) return;
    } else if (!req.body?.originalFolderId || !req.body?.publicSlug) {
        return res.status(403).json({
            success: false,
            code: 'MANAGEMENT_TOKEN_REQUIRED',
            error: 'Album chưa được khởi tạo. Cần thông tin thư mục Drive và slug để tạo album.'
        });
    } else if (!(await requireDriveCreationProof(req, res))) {
        return;
    }
    const { isEnabled, text, maxSelections, reopenSelection, publicSlug, clientName, displayName, originalFolderId, studioName, studioLogo, accentColor, paymentStatus, paymentAmount, paymentTotal, paymentDeposit, paymentPaid, paymentBalance, paymentPayer, paymentNote, galleryType, partyGallery, gallerySections, expiresDays, expiresAt } = req.body;
    const isBackgroundSync = req.get('x-finder-background-sync') === '1';
    const hasLimitUpdate = maxSelections !== undefined;
    const previousLimit = albumSettingsDatabase[folderId]?.maxSelections;
    const parsedLimit = hasLimitUpdate
        ? (String(maxSelections ?? '').trim() === '' ? 0 : (parseInt(maxSelections, 10) || 0))
        : previousLimit;
    // An older Desktop history may not know about a limit that was configured
    // online. Its background sync sends 0; never let that erase a real limit.
    const preserveBackgroundLimit = isBackgroundSync && hasLimitUpdate && parsedLimit === 0 && Number(previousLimit) > 0;
    const nextLimit = preserveBackgroundLimit ? Number(previousLimit) : parsedLimit;
    const incomingStudioName = String(studioName || 'Finder').trim().toUpperCase() || 'FINDER';
    const existingStudioName = String(albumSettingsDatabase[folderId]?.studioName || '').trim();
    // The same protection applies to the brand: a legacy local record with no
    // custom brand must not replace an existing Studio name on the server.
    const preserveBackgroundStudio = isBackgroundSync && isDefaultStudioName(incomingStudioName) && !isDefaultStudioName(existingStudioName);
    
    if(!albumSettingsDatabase[folderId]) {
        albumSettingsDatabase[folderId] = { 
            isEnabled: isEnabled !== undefined ? isEnabled : true, 
            text: text || "FINDERPICTURE STUDIO", 
            maxSelections: nextLimit,
            publicSlug: publicSlug || `album-${String(folderId).slice(-6).toLowerCase()}`,
            clientName: clientName || text || 'Album khách hàng',
            displayName: String(displayName || 'Finder').trim() || 'Finder',
            originalFolderId: originalFolderId || null,
            galleryType: galleryType || (partyGallery ? 'party' : 'selection'),
            partyGallery: Boolean(partyGallery || galleryType === 'party'),
            gallerySections: Array.isArray(gallerySections) ? gallerySections : [],
            expiresDays: Number(expiresDays) || 60,
            expiresAt: expiresAt || null,
            paymentStatus: paymentStatus || 'unpaid', paymentAmount: Number(paymentAmount) || 0, paymentTotal: Number(paymentTotal ?? paymentAmount) || 0, paymentDeposit: Number(paymentDeposit) || 0, paymentPaid: Number(paymentPaid) || 0, paymentBalance: Number(paymentBalance) || 0, paymentPayer: paymentPayer || 'client', paymentNote: String(paymentNote || ''),
            studioName: String(studioName || 'Finder').trim().toUpperCase(),
            studioLogo: studioLogo || '',
            accentColor: accentColor || '#7c8cff'
        };
        albumSettingsDatabase[folderId].managementToken = createManagementToken();
    } else {
        if (!albumSettingsDatabase[folderId].managementToken) albumSettingsDatabase[folderId].managementToken = createManagementToken();
        if (isEnabled !== undefined) albumSettingsDatabase[folderId].isEnabled = isEnabled;
        if (text !== undefined) albumSettingsDatabase[folderId].text = text;
        if (maxSelections !== undefined && !preserveBackgroundLimit) albumSettingsDatabase[folderId].maxSelections = nextLimit;
        if (publicSlug) albumSettingsDatabase[folderId].publicSlug = slugifyAlbumName(publicSlug);
        if (clientName !== undefined) albumSettingsDatabase[folderId].clientName = clientName;
        if (displayName !== undefined) albumSettingsDatabase[folderId].displayName = String(displayName || 'Finder').trim() || 'Finder';
        if (originalFolderId !== undefined) albumSettingsDatabase[folderId].originalFolderId = originalFolderId;
        if (galleryType !== undefined) albumSettingsDatabase[folderId].galleryType = galleryType;
        if (partyGallery !== undefined) albumSettingsDatabase[folderId].partyGallery = Boolean(partyGallery);
        if (Array.isArray(gallerySections)) albumSettingsDatabase[folderId].gallerySections = gallerySections;
        if (expiresDays !== undefined) albumSettingsDatabase[folderId].expiresDays = Number(expiresDays) || 60;
        if (expiresAt !== undefined) albumSettingsDatabase[folderId].expiresAt = expiresAt || null;
        if (paymentStatus !== undefined) albumSettingsDatabase[folderId].paymentStatus = paymentStatus;
        if (paymentAmount !== undefined) albumSettingsDatabase[folderId].paymentAmount = Number(paymentAmount) || 0;
        if (paymentTotal !== undefined) albumSettingsDatabase[folderId].paymentTotal = Number(paymentTotal) || 0;
        if (paymentDeposit !== undefined) albumSettingsDatabase[folderId].paymentDeposit = Number(paymentDeposit) || 0;
        if (paymentPaid !== undefined) albumSettingsDatabase[folderId].paymentPaid = Number(paymentPaid) || 0;
        if (paymentBalance !== undefined) albumSettingsDatabase[folderId].paymentBalance = Number(paymentBalance) || 0;
        if (paymentPayer !== undefined) albumSettingsDatabase[folderId].paymentPayer = paymentPayer;
        if (paymentNote !== undefined) albumSettingsDatabase[folderId].paymentNote = String(paymentNote || '');
        if (studioName !== undefined && !preserveBackgroundStudio) albumSettingsDatabase[folderId].studioName = incomingStudioName;
        if (studioLogo !== undefined) albumSettingsDatabase[folderId].studioLogo = studioLogo;
        if (accentColor !== undefined) albumSettingsDatabase[folderId].accentColor = accentColor;
    }
    // Khi admin thay đổi hạn mức, khách cần được mở lại album để bổ sung
    // lựa chọn. Dữ liệu likedImagesDatabase vẫn giữ nguyên, chỉ bỏ trạng thái
    // đã chốt; vì vậy các ảnh cũ không bị mất và server nhận được ảnh mới.
    // Explicit admin edits (including older desktop builds that do not send
    // reopenSelection) reopen the album. Startup/background sync must not.
    if (hasLimitUpdate && !isBackgroundSync && (reopenSelection === true || previousLimit === undefined || Number(previousLimit) !== nextLimit)) {
        delete finalizedDatabase[folderId];
        albumSettingsDatabase[folderId].selectionReopenedAt = new Date().toISOString();
    }
    // Keep the request alive briefly so Vercel can finish the small settings
    // write before freezing the function, but never let a Firebase network
    // stall block Desktop indefinitely.
    let persistencePending = false;
    let driveBrandingSaved = false;
    try {
        driveBrandingSaved = await Promise.race([
            saveDriveBranding(folderId, albumSettingsDatabase[folderId].studioName),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Drive branding write timeout')), 7000))
        ]);
    } catch (error) {
        console.warn('Không thể lưu tên Studio vào Drive:', JSON.stringify({ message: error.message, code: error.code }));
    }
    if (firebaseDb || isSupabaseConfigured()) {
        try {
            await Promise.race([
                persistAlbumSettings(folderId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Settings write timeout')), 7000))
            ]);
        } catch (error) {
            persistencePending = true;
            console.warn('Không thể lưu settings album:', JSON.stringify({ message: error.message, code: error.code }));
        }
    }
    res.json({ success: true, settings: publicAlbumSettings(albumSettingsDatabase[folderId]), managementToken: albumSettingsDatabase[folderId].managementToken, persistencePending, driveBrandingSaved });
});

// Desktop history is cached locally for responsiveness, but its durable copy
// now lives in Supabase instead of the legacy Firebase studioAlbumHistory node.
app.post('/api/album/:folderId/manager-history', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!(await requireAlbumManagementOrDriveBootstrap(req, res, folderId))) return;
    if (!isSupabaseConfigured()) return res.status(503).json({ success: false, error: 'Supabase chưa được cấu hình.' });
    const incoming = req.body?.history;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return res.status(400).json({ success: false, error: 'Dữ liệu lịch sử album không hợp lệ.' });
    }
    const { managementToken, ...safeHistory } = incoming;
    albumHistoryDatabase[folderId] = {
        ...(albumHistoryDatabase[folderId] || {}),
        ...stripUndefined(safeHistory),
        id: String(safeHistory.id || folderId),
        updatedAt: new Date().toISOString()
    };
    if (!albumSettingsDatabase[folderId]) {
        albumSettingsDatabase[folderId] = {
            isEnabled: true,
            text: 'FINDERPICTURE STUDIO',
            maxSelections: Number(safeHistory.maxSelections) || 0,
            publicSlug: safeHistory.publicSlug || `album-${String(folderId).slice(-6).toLowerCase()}`,
            clientName: safeHistory.clientName || safeHistory.name || 'Album khách hàng',
            displayName: safeHistory.displayName || 'Finder',
            originalFolderId: safeHistory.originalFolderId || null,
            galleryType: safeHistory.galleryType || 'selection',
            partyGallery: safeHistory.galleryType === 'party',
            gallerySections: Array.isArray(safeHistory.gallerySections) ? safeHistory.gallerySections : [],
            studioName: String(safeHistory.studioName || 'Finder').trim().toUpperCase(),
            managementToken: createManagementToken()
        };
    }
    await persistState(folderId);
    res.json({ success: true });
});

function cronRequestAuthorized(req) {
    const secret = String(process.env.CRON_SECRET || process.env.FINDER_CRON_SECRET || '').trim();
    if (!secret) return false;
    const authorization = String(req.get('authorization') || '');
    const provided = authorization.replace(/^Bearer\s+/i, '').trim() || String(req.get('x-cron-secret') || '').trim();
    const providedBuffer = Buffer.from(provided);
    const secretBuffer = Buffer.from(secret);
    return providedBuffer.length === secretBuffer.length && crypto.timingSafeEqual(providedBuffer, secretBuffer);
}

// Vercel invokes this endpoint once per day. It only removes disposable
// thumbnail objects older than the configured TTL; Drive originals,
// downloads and album metadata are never touched.
app.get('/api/internal/cleanup-thumbnails', async (req, res) => {
    if (!cronRequestAuthorized(req)) return res.status(401).json({ success: false, error: 'Cron secret không hợp lệ.' });
    try {
        const result = await cleanupExpiredThumbnailObjects();
        return res.json({ success: true, ...result });
    } catch (error) {
        logStructuredEvent('thumbnail_cache.cleanup_error', { message: error.message });
        return res.status(500).json({ success: false, error: 'Không thể dọn cache thumbnail.' });
    }
});

// POST is useful for an operator to trigger the same guarded cleanup during
// staging without changing the production cron schedule.
app.post('/api/internal/cleanup-thumbnails', async (req, res) => {
    if (!cronRequestAuthorized(req)) return res.status(401).json({ success: false, error: 'Cron secret không hợp lệ.' });
    try {
        const result = await cleanupExpiredThumbnailObjects();
        return res.json({ success: true, ...result });
    } catch (error) {
        logStructuredEvent('thumbnail_cache.cleanup_error', { message: error.message });
        return res.status(500).json({ success: false, error: 'Không thể dọn cache thumbnail.' });
    }
});

// Gallery giao ảnh tiệc/PSC độc lập. Ảnh được đọc trực tiếp từ thư mục Drive
// đã chọn; không tạo ORIGINAL/CHECK và không đi qua luồng chọn ảnh.
app.post('/api/party-gallery', async (req, res) => {
    await loadPersistentState();
    const driveFolderId = normalizeDriveFolderId(
        typeof req.body?.driveFolderId === 'string' ? req.body.driveFolderId : (typeof req.body?.folderId === 'string' ? req.body.folderId : ''),
        ''
    );
    const folderId = typeof req.body?.galleryId === 'string' && req.body.galleryId.trim() ? req.body.galleryId.trim() : driveFolderId;
    if (!driveFolderId) return res.status(400).json({ success: false, error: 'Thiếu thư mục Google Drive.' });
    // Creating a new gallery does not have a token yet. Reusing an existing
    // gallery id, however, is an update and must not overwrite its settings
    // without the album's management token.
    if (Object.prototype.hasOwnProperty.call(albumSettingsDatabase, folderId)) {
        if (!(await requireAlbumManagementOrDriveBootstrap(req, res, folderId))) return;
    } else if (!(await requireDriveCreationProof(req, res))) {
        return;
    }
    const folderName = String(req.body?.folderName || req.body?.galleryName || 'Ảnh tiệc').trim() || 'Ảnh tiệc';
    const galleryName = String(req.body?.galleryName || folderName).trim() || folderName;
    const sectionDriveFolderId = normalizeDriveFolderId(req.body?.sectionDriveFolderId, driveFolderId) || driveFolderId;
    const studioName = String(req.body?.studioName || 'Finder').trim().toUpperCase() || 'FINDER';
    const requestedSlug = slugifyAlbumName(req.body?.publicSlug || folderName);
    // The slug contains the customer Drive root suffix, so it can be recovered
    // from Drive even if the local/Firebase mapping is unavailable.
    const driveTail = String(driveFolderId).slice(-6);
    const publicSlug = canonicalPublicSlug(requestedSlug.endsWith(`-${canonicalPublicSlug(driveTail)}`) ? requestedSlug : `${requestedSlug}-${driveTail}`);
    const expiresDays = Math.min(3650, Math.max(1, Number(req.body?.expiresDays) || 60));
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresDays * 86400000).toISOString();
    const sectionName = String(req.body?.sectionName || '').trim();
    const managementToken = createManagementToken();
    albumSettingsDatabase[folderId] = {
        ...(albumSettingsDatabase[folderId] || {}),
        isEnabled: true,
        text: 'ẢNH TIỆC',
        maxSelections: 0,
        publicSlug,
        clientName: folderName,
        displayName: galleryName,
        originalFolderId: driveFolderId,
        driveFolderName: folderName,
        gallerySections: [{ id: sectionDriveFolderId, name: sectionName || 'Tất cả', driveFolderId: sectionDriveFolderId, createdAt }],
        studioName,
        galleryType: 'party',
        partyGallery: true,
        checkReady: false,
        checkVersion: 0,
        workflowStatus: 'completed',
        finalizedAt: createdAt,
        expiresAt,
        expiresDays,
        paymentStatus: req.body?.paymentStatus || 'unpaid',
        paymentAmount: Number(req.body?.paymentAmount) || 0,
        managementToken
    };
    finalizedDatabase[folderId] = true;
    await persistState(folderId);
    res.json({ success: true, folderId, driveFolderId, publicSlug, managementToken, link: `https://${process.env.ONLINE_DOMAIN || 'finder-swart-pi.vercel.app'}/a/${publicSlug}`, expiresAt, expiresDays });
});

// Thêm một ngày/đợt ảnh vào gallery tiệc hiện tại. Link publicSlug giữ nguyên;
// chỉ bổ sung thư mục Drive và một mục hiển thị mới cho trang khách.
app.post('/api/party-gallery/:folderId/sections', async (req, res) => {
    await loadPersistentState();
    const folderId = req.params.folderId;
    const settings = albumSettingsDatabase[folderId];
    if (!settings || settings.galleryType !== 'party') return res.status(404).json({ success: false, error: 'Không tìm thấy gallery tiệc.' });
    if (!(await requireAlbumManagementOrDriveBootstrap(req, res, folderId))) return;
    const driveFolderId = normalizeDriveFolderId(req.body?.driveFolderId, '');
    const name = String(req.body?.sectionName || '').trim();
    if (!driveFolderId || !name) return res.status(400).json({ success: false, error: 'Thiếu tên ngày hoặc thư mục Drive.' });
    const sections = Array.isArray(settings.gallerySections) ? settings.gallerySections : [{ id: settings.originalFolderId || folderId, name: 'Ngày 1', driveFolderId: settings.originalFolderId || folderId }];
    if (!sections.some(section => section.driveFolderId === driveFolderId)) sections.push({ id: driveFolderId, name, driveFolderId, createdAt: new Date().toISOString() });
    settings.gallerySections = sections;
    await persistState(folderId);
    res.json({ success: true, gallerySections: sections, publicSlug: settings.publicSlug });
});

app.get('/api/album/:folderId/settings', async (req, res) => {
    await loadPersistentState();
    const folderId = req.params.folderId;
    if (albumExists(folderId)) issueGuestCapability(res, folderId);
    res.json({
        success: true,
        settings: publicAlbumSettings(albumSettingsDatabase[folderId] || { isEnabled: true, text: 'FINDERPICTURE STUDIO', maxSelections: 0, originalFolderId: null, checkReady: false, checkVersion: 0, checkNeedsRevision: false, workflowStatus: 'selection_open', selectionReopenedAt: null, paymentStatus: 'unpaid', paymentAmount: 0, publicSlug: `album-${String(folderId).slice(-6).toLowerCase()}`, clientName: 'Album khách hàng', displayName: 'Finder', studioName: 'Finder', studioLogo: '', accentColor: '#7c8cff' }),
        isFinalized: !!finalizedDatabase[folderId]
    });
});

app.post('/api/album/:folderId/check', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!(await requireAlbumManagementOrDriveBootstrap(req, res, folderId))) return;
    const checkFolderId = typeof req.body?.checkFolderId === 'string' ? req.body.checkFolderId.trim() : '';
    if (!checkFolderId) return res.status(400).json({ success: false, error: 'Thiếu mã thư mục CHECK.' });
    const current = albumSettingsDatabase[folderId] || { isEnabled: true, text: 'FINDERPICTURE STUDIO', maxSelections: 0 };
    const nextVersion = Math.max(1, Number(current.checkVersion || 0) + 1);
    const version = Number(req.body?.version) || nextVersion;
    const history = Array.isArray(current.checkHistory) ? current.checkHistory : [];
    history.push({ version, checkFolderId, checkImageCount: Number(req.body?.checkImageCount) || 0, uploadedAt: new Date().toISOString() });
    albumSettingsDatabase[folderId] = {
        ...current,
        checkFolderId,
        checkVersion: version,
        checkHistory: history.slice(-30),
        checkReady: true,
        checkNeedsRevision: false,
        workflowStatus: 'check_pending',
        checkUpdatedAt: new Date().toISOString(),
        checkImageCount: Number(req.body?.checkImageCount) || 0
    };
    delete albumCheckCacheDatabase[folderId];
    await persistState(folderId);
    res.json({ success: true, checkReady: true, checkFolderId });
});

app.post('/api/album/:folderId/check/confirm', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!albumExists(folderId)) return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', error: 'Không tìm thấy album.' });
    if (!requireGuestCapability(req, res, folderId)) return;
    const settings = albumSettingsDatabase[folderId] || {};
    if (!settings.checkReady || !settings.checkFolderId) return res.status(400).json({ success: false, error: 'Album chưa có phiên bản CHECK để xác nhận.' });
    settings.checkNeedsRevision = false;
    settings.checkAcceptedAt = new Date().toISOString();
    settings.expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    settings.workflowStatus = 'completed';
    albumSettingsDatabase[folderId] = settings;
    await persistState(folderId);
    res.json({ success: true, completedAt: settings.checkAcceptedAt, expiresAt: settings.expiresAt, checkVersion: settings.checkVersion || 1 });
});

app.post('/api/album/:folderId/finalize', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!albumExists(folderId)) return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', error: 'Không tìm thấy album.' });
    if (!requireGuestCapability(req, res, folderId)) return;
    const settings = albumSettingsDatabase[folderId] || {};
    finalizedDatabase[folderId] = true;
    settings.workflowStatus = 'completed';
    settings.finalizedAt = settings.finalizedAt || new Date().toISOString();
    settings.expiresAt = settings.expiresAt || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    albumSettingsDatabase[folderId] = settings;
    await persistState(folderId);
    res.json({ success: true, workflowStatus: settings.workflowStatus, finalizedAt: settings.finalizedAt, expiresAt: settings.expiresAt });
});

app.delete('/api/album/:folderId', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!requireAlbumManagement(req, res, folderId)) return;
    if (!bannedAlbums.includes(folderId)) bannedAlbums.push(folderId);
    delete albumCacheDatabase[folderId];
    delete albumCheckCacheDatabase[folderId];
    delete likedImagesDatabase[folderId];
    delete checkNotesDatabase[folderId];
    delete albumSettingsDatabase[folderId];
    delete finalizedDatabase[folderId];
    await persistState(folderId, { deletePartition: true });
    res.json({ success: true, message: "Album đã bị hủy!" });
});

app.delete('/api/album/flush-all/data', async (req, res) => {
    if (process.env.FINDER_ENABLE_DANGER_ZONE !== '1') return res.status(403).json({ success: false, error: 'Tính năng xóa toàn bộ dữ liệu đang bị khóa.' });
    albumCacheDatabase = {}; albumCheckCacheDatabase = {}; likedImagesDatabase = {}; checkNotesDatabase = {}; albumSettingsDatabase = {}; finalizedDatabase = {}; bannedAlbums = [];
    await persistState(null, { clearAll: true });
    res.json({ success: true, message: "All data cleared" });
});

// Rollback is intentionally disabled in normal deployments. Enable only for
// a controlled maintenance window with FINDER_ENABLE_DANGER_ZONE=1 and pass
// the backupId returned by the migration marker/logs.
app.get('/api/internal/firebase-migration/status', async (req, res) => {
    if (process.env.FINDER_ENABLE_DANGER_ZONE !== '1') {
        return res.status(403).json({ success: false, error: 'Migration status đang bị khóa.' });
    }
    if (!firebaseDb) return res.status(503).json({ success: false, error: 'Firebase chưa được cấu hình.' });
    try {
        const snapshot = await firebaseDb.ref('finderPictureStateMigration/v1').once('value');
        res.json({ success: true, migration: snapshot.val() || null });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Không thể đọc trạng thái migration.' });
    }
});

app.post('/api/internal/firebase-migration/rollback', async (req, res) => {
    if (process.env.FINDER_ENABLE_DANGER_ZONE !== '1') {
        return res.status(403).json({ success: false, error: 'Rollback đang bị khóa.' });
    }
    if (!firebaseDb) return res.status(503).json({ success: false, error: 'Firebase chưa được cấu hình.' });
    const backupId = String(req.body?.backupId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(backupId)) {
        return res.status(400).json({ success: false, error: 'backupId không hợp lệ.' });
    }
    try {
        const snapshot = await firebaseDb.ref(`finderPictureStateBackups/${backupId}`).once('value');
        const aggregate = snapshot.val()?.data;
        if (!aggregate) return res.status(404).json({ success: false, error: 'Không tìm thấy bản sao lưu.' });
        const updates = {
            finderPictureState: aggregate,
            'finderPictureStateMeta/bannedAlbums': aggregate.bannedAlbums || []
        };
        const ids = new Set([
            ...Object.keys(aggregate.likedImagesDatabase || {}),
            ...Object.keys(aggregate.checkNotesDatabase || {}),
            ...Object.keys(aggregate.albumSettingsDatabase || {}),
            ...Object.keys(aggregate.finalizedDatabase || {}),
            ...(aggregate.bannedAlbums || [])
        ]);
        for (const folderId of ids) {
            updates[`finderPictureStateByAlbum/${firebaseAlbumKey(folderId)}`] = {
                folderId,
                likedImages: (aggregate.likedImagesDatabase || {})[folderId] || {},
                checkNotes: (aggregate.checkNotesDatabase || {})[folderId] || {},
                settings: (aggregate.albumSettingsDatabase || {})[folderId] || null,
                finalized: Boolean((aggregate.finalizedDatabase || {})[folderId]),
                banned: Array.isArray(aggregate.bannedAlbums) && aggregate.bannedAlbums.includes(folderId),
                updatedAt: new Date().toISOString()
            };
        }
        // Clear partitions not present in the selected backup before writing
        // restored album partitions; avoid overlapping Firebase update paths.
        await firebaseDb.ref('finderPictureStateByAlbum').remove();
        await firebaseDb.ref().update(updates);
        await firebaseDb.ref('finderPictureStateMigration/v1').update({ status: 'completed', version: 1, restoredBackupId: backupId, restoredAt: new Date().toISOString() });
        firebaseMigrationPromise = null;
        res.json({ success: true, backupId, restoredAlbums: ids.size });
    } catch (error) {
        console.error('Firebase rollback failed:', error.message);
        res.status(500).json({ success: false, error: 'Không thể rollback Firebase.' });
    }
});

app.get('/api/album/:folderId', async (req, res) => {
    let albumStage = 'load-state';
    try {
        await loadPersistentState();
        let { folderId } = req.params;
        if (bannedAlbums.includes(folderId)) return res.status(403).json({ success: false, error: "Album đã bị hủy." });
        if (!Object.prototype.hasOwnProperty.call(albumSettingsDatabase, folderId) && !albumCacheDatabase[folderId]) {
            return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', requestId: req.requestId, error: 'Không tìm thấy album.' });
        }
        issueGuestCapability(res, folderId);

        const currentAlbumLikes = likedImagesDatabase[folderId] || {};
        let currentSettings = albumSettingsDatabase[folderId] || { isEnabled: true, text: "FINDERPICTURE STUDIO", maxSelections: 0, originalFolderId: null, checkReady: false, checkVersion: 0, checkNeedsRevision: false, workflowStatus: 'selection_open', selectionReopenedAt: null, paymentStatus: 'unpaid', paymentAmount: 0, publicSlug: `album-${String(folderId).slice(-6).toLowerCase()}`, clientName: 'Album khách hàng', studioName: 'Finder', studioLogo: '', accentColor: '#7c8cff' };
        // expiresAt hiện chỉ là mốc tham khảo để hiển thị cho khách hàng.
        // Không khóa link, không xóa album và không xóa file Google Drive tự động.
        let isFinalized = !!finalizedDatabase[folderId];
        // Gallery/PSC never reads a CHECK folder. Older records may still
        // contain a stale `checkFolderId` (including `.`), which otherwise
        // makes Drive return `File not found: .` and blocks the whole gallery.
        const safeCheckFolderId = normalizeDriveFolderId(currentSettings.checkFolderId, '');
        let hasCheckFolder = currentSettings.galleryType !== 'party' && Boolean(currentSettings.checkReady && safeCheckFolderId);
        // Keep the response-shaping helpers available on both the cache fast
        // path and the Drive path.  The cache can be populated by a previous
        // compact request, so declaring these helpers below the cache return
        // would hit the temporal-dead-zone and turn the next request into a
        // 500 error.
        const compactResponse = String(req.query?.compact || '') === '1';
        const pagedResponse = String(req.query?.paged || '') === '1';
        const pageSize = Math.max(8, Math.min(48, Number(req.query?.limit) || 24));
        const pageCursor = decodeAlbumPageCursor(req.query?.cursor);
        if (!pageCursor) return res.status(400).json({ success: false, code: 'ALBUM_CURSOR_INVALID', error: 'Cursor tải ảnh không hợp lệ.' });
        const compactFile = file => ({
            id: file.id,
            fullName: file.fullName,
            shortName: file.shortName,
            thumbnail: file.thumbnail,
            gallerySectionId: file.gallerySectionId,
            gallerySectionName: file.gallerySectionName
        });
        const responseFile = file => compactResponse ? compactFile(file) : file;

        if (!pagedResponse && albumCacheDatabase[folderId] && albumCacheDatabase[folderId].length > 0 && (!hasCheckFolder || Object.prototype.hasOwnProperty.call(albumCheckCacheDatabase, folderId))) {
            const cachedFiles = albumCacheDatabase[folderId].map(responseFile);
            const cachedCheckFiles = (albumCheckCacheDatabase[folderId] || []).map(responseFile);
            return res.json({ success: true, folderId, files: cachedFiles, checkFiles: cachedCheckFiles, gallerySections: currentSettings.gallerySections || [], liked_list: currentAlbumLikes, check_notes: checkNotesDatabase[folderId] || {}, settings: publicAlbumSettings(currentSettings), isFinalized });
        }

        albumStage = 'drive-auth';
        const albumOAuth = await getAlbumDriveAuth(folderId);
        const serviceAccountAuth = albumOAuth ? null : getServiceAccountAuth();
        let drive;
        if (albumOAuth) drive = google.drive({ version: 'v3', auth: albumOAuth });
        else if (serviceAccountAuth) drive = google.drive({ version: 'v3', auth: serviceAccountAuth });
        else {
            const tokens = getStoredTokens();
            if (!tokens) return res.status(503).json({ error: 'Server chưa cấu hình GOOGLE_SERVICE_ACCOUNT.' });
            const oauth2Client = getOAuth2Client();
            if (!oauth2Client) return res.status(503).json({ error: 'Thiếu cấu hình Google Drive trên Server.' });
            oauth2Client.setCredentials(tokens);
            drive = google.drive({ version: 'v3', auth: oauth2Client });
        }

        const requestedSlug = canonicalPublicSlug(req.query?.slug || '');
        const configuredRootForRecovery = normalizeDriveFolderId(currentSettings.originalFolderId, '');
        const tokenRootForRecovery = normalizeDriveFolderId(/** @type {any} */ (albumOAuth)?.finderDriveFolderId, '');
        const hasUsableGalleryStructure = currentSettings.galleryType === 'party'
            ? Boolean(configuredRootForRecovery && Array.isArray(currentSettings.gallerySections) && currentSettings.gallerySections.some(section => normalizeDriveFolderId(section?.driveFolderId || section?.id, '')))
            : Boolean(configuredRootForRecovery);
        if (requestedSlug && (canonicalPublicSlug(currentSettings.publicSlug) !== requestedSlug || !hasUsableGalleryStructure)) {
            albumStage = 'drive-structure-recovery';
            const recovered = tokenRootForRecovery
                ? await recoverDriveStructureFromRoot(drive, tokenRootForRecovery)
                : await recoverDriveStructureBySlug(drive, requestedSlug);
            if (recovered) {
                currentSettings = {
                    ...currentSettings,
                    publicSlug: requestedSlug,
                    clientName: recovered.folderName,
                    displayName: recovered.folderName,
                    originalFolderId: recovered.originalFolderId,
                    galleryType: recovered.galleryType,
                    partyGallery: recovered.galleryType === 'party',
                    gallerySections: recovered.gallerySections,
                    checkReady: false,
                    checkFolderId: null,
                    workflowStatus: recovered.galleryType === 'party' ? 'completed' : 'selection_open'
                };
                albumSettingsDatabase[folderId] = currentSettings;
                if (recovered.galleryType === 'party') {
                    finalizedDatabase[folderId] = true;
                    isFinalized = true;
                }
                await persistState(folderId);
            }
        }

        albumStage = 'drive-branding';
        const brandingFolderId = currentSettings.galleryType === 'party'
            ? normalizeDriveFolderId(currentSettings.originalFolderId, '')
            : folderId;
        // Settings already contain the configured Studio name. Reading the
        // Drive appProperties on every public page view is redundant and adds
        // another Google API round-trip; only recover branding when the saved
        // value is still the default.
        const driveStudioName = brandingFolderId && isDefaultStudioName(currentSettings.studioName)
            ? await readDriveBranding(drive, brandingFolderId)
            : null;
        if (driveStudioName) {
            currentSettings = { ...currentSettings, studioName: driveStudioName };
            albumSettingsDatabase[folderId] = currentSettings;
        }
        albumStage = 'after-drive-branding';

        // Recover albums created by older desktop builds when the settings
        // write was interrupted after the Drive upload. The ORIGINAL child
        // folder is deterministic and avoids showing an empty root folder.
        if (!currentSettings.originalFolderId && currentSettings.galleryType !== 'party') {
            const original = await drive.files.list({
                q: `'${folderId}' in parents and name = 'ORIGINAL' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            const recoveredOriginal = original.data.files?.[0]?.id;
            if (recoveredOriginal) {
                currentSettings = { ...currentSettings, originalFolderId: recoveredOriginal };
                albumSettingsDatabase[folderId] = currentSettings;
                try { await persistState(folderId); } catch (error) { console.warn('Không thể lưu lại thư mục ORIGINAL:', error.message); }
            }
        }

        // Drive tạo thumbnail theo kích thước được yêu cầu, nên trang khách chỉ tải
        // đúng số pixel cần hiển thị thay vì tải ảnh gốc dung lượng lớn.
        const driveImage = (fileId, size = 'thumb', download = false) => {
            const query = new URLSearchParams({ size });
            if (download) query.set('download', '1');
            return `/api/album/${encodeURIComponent(folderId)}/image/${encodeURIComponent(fileId)}?${query.toString()}`;
        };
        const toClientFile = file => {
            const nameWithoutExt = path.basename(file.name, path.extname(file.name));
            const base = {
                id: file.id,
                fullName: file.name,
                shortName: nameWithoutExt,
                thumbnail: driveImage(file.id, 'thumb'),
                gallerySectionId: file.gallerySectionId,
                gallerySectionName: file.gallerySectionName
            };
            return {
                ...base,
                preview: driveImage(file.id, 'preview'),
                // Lightbox vẫn dùng thumbnail lớn của Drive nhưng được proxy
                // qua server để không cần cấp quyền anyone/reader.
                lightbox: driveImage(file.id, 'lightbox'),
                originalUrl: driveImage(file.id, 'original', true)
            };
        };
        // Google Drive does not guarantee a stable order unless `orderBy` is
        // supplied. Keep the same natural filename order for both paged and
        // non-paged responses so the first image is always the first file the
        // client sees (01, 02, 10 instead of 01, 10, 02).
        const naturalFilenameCompare = (a, b) => String(a?.name || '').localeCompare(
            String(b?.name || ''),
            undefined,
            { numeric: true, sensitivity: 'base' }
        );
        const listDriveImages = async parentId => {
            const files = [];
            let pageToken;
            do {
                const response = await drive.files.list({
                    q: `'${parentId}' in parents and trashed = false`,
                    includeItemsFromAllDrives: true, supportsAllDrives: true,
                    fields: 'nextPageToken,files(id, name, mimeType, parents, webContentLink, thumbnailLink)',
                    orderBy: 'name_natural',
                    pageSize: 1000, pageToken
                });
                files.push(...(response.data.files || []));
                pageToken = response.data.nextPageToken || undefined;
            } while (pageToken);
            return files
                .filter(file => /\.(jpe?g|png|webp)$/i.test(file.name || ''))
                .sort(naturalFilenameCompare)
                .map(toClientFile);
        };
        const listDriveImagesPage = async (parentId, pageToken, requestedPageSize) => {
            const response = await drive.files.list({
                q: `'${parentId}' in parents and trashed = false and mimeType contains 'image/'`,
                includeItemsFromAllDrives: true, supportsAllDrives: true,
                fields: 'nextPageToken,files(id, name, mimeType, parents, webContentLink, thumbnailLink)',
                orderBy: 'name_natural',
                pageSize: requestedPageSize, pageToken: pageToken || undefined
            });
            const files = (response.data.files || [])
                .filter(file => /\.(jpe?g|png|webp)$/i.test(file.name || ''))
                .sort(naturalFilenameCompare)
                .map(toClientFile);
            return { files, nextPageToken: response.data.nextPageToken || null };
        };
        // Album mới lưu ảnh gốc trong ORIGINAL; album cũ vẫn đọc ảnh ở root.
        const configuredRoot = normalizeDriveFolderId(currentSettings.originalFolderId, '');
        const configuredSections = currentSettings.galleryType === 'party' && Array.isArray(currentSettings.gallerySections)
            ? currentSettings.gallerySections.map(section => {
                const driveFolderId = normalizeDriveFolderId(section?.driveFolderId || section?.id, configuredRoot);
                return driveFolderId ? { ...section, id: driveFolderId, driveFolderId } : null;
            }).filter(Boolean)
            : [];
        const sections = configuredSections.length
            ? configuredSections
            : [{ id: configuredRoot || normalizeDriveFolderId(folderId, 'root'), name: currentSettings.galleryType === 'party' ? 'Tất cả' : 'Ảnh', driveFolderId: configuredRoot || normalizeDriveFolderId(folderId, 'root') }];
        hasCheckFolder = currentSettings.galleryType !== 'party' && Boolean(currentSettings.checkReady && safeCheckFolderId);
        albumStage = 'list-gallery-and-check-images';
        if (pagedResponse) {
            const sectionTokens = pageCursor.sections && typeof pageCursor.sections === 'object' ? pageCursor.sections : {};
            const sectionPages = await Promise.all(sections.map(async section => {
                const key = String(section.id || section.driveFolderId);
                const hasSectionCursor = Object.prototype.hasOwnProperty.call(sectionTokens, key);
                if (hasSectionCursor && !sectionTokens[key]) return { files: [], nextPageToken: null, key };
                const page = await listDriveImagesPage(section.driveFolderId, sectionTokens[key], pageSize);
                return {
                    ...page,
                    files: page.files.map(file => ({
                        ...file,
                        gallerySectionId: section.id || section.driveFolderId,
                        gallerySectionName: section.name || 'Ảnh'
                    })),
                    key
                };
            }));
            const hasCheckCursor = Object.prototype.hasOwnProperty.call(pageCursor, 'checkToken');
            const checkPage = hasCheckCursor && !pageCursor.checkToken
                ? { files: [], nextPageToken: null }
                : hasCheckFolder
                ? await listDriveImagesPage(safeCheckFolderId, pageCursor.checkToken, pageSize)
                : { files: [], nextPageToken: null };
            const nextSections = {};
            sectionPages.forEach(page => {
                if (page.nextPageToken) nextSections[page.key] = page.nextPageToken;
                else nextSections[page.key] = null;
            });
            const hasMore = Object.values(nextSections).some(Boolean) || Boolean(checkPage.nextPageToken);
            const nextCursor = hasMore ? encodeAlbumPageCursor({
                sections: nextSections,
                checkToken: checkPage.nextPageToken || null
            }) : null;
            // Paged image responses intentionally exclude liked_list and
            // check_notes. Those mutable fields are served by /meta so the
            // image pages can be cached safely at the edge.
            res.set('Cache-Control', 'public, max-age=5, s-maxage=30, stale-while-revalidate=120');
            return res.json({
                success: true,
                folderId,
                files: sectionPages.flatMap(page => page.files).map(responseFile),
                checkFiles: checkPage.files.map(responseFile),
                gallerySections: sections,
                settings: publicAlbumSettings(currentSettings),
                isFinalized,
                nextCursor,
                hasMore,
                pageSize
            });
        }
        // Gallery sections and the latest CHECK folder are independent Drive
        // reads. Fetch them together so CHECK albums do not wait for the full
        // original gallery listing before the response can be rendered.
        const [sectionFiles, checkFiles] = await Promise.all([
            Promise.all(sections.map(async section => (await listDriveImages(section.driveFolderId)).map(file => ({ ...file, gallerySectionId: section.id || section.driveFolderId, gallerySectionName: section.name || 'Ảnh' })))),
            hasCheckFolder ? listDriveImages(safeCheckFolderId) : Promise.resolve([])
        ]);
        const files = sectionFiles.flat();

        albumCacheDatabase[folderId] = files;
        if (hasCheckFolder) albumCheckCacheDatabase[folderId] = checkFiles;
        res.json({ success: true, folderId, files: files.map(responseFile), checkFiles: checkFiles.map(responseFile), gallerySections: sections, liked_list: currentAlbumLikes, check_notes: checkNotesDatabase[folderId] || {}, settings: publicAlbumSettings(currentSettings), isFinalized });
    } catch (error) {
        console.error('Album load failed:', JSON.stringify({ folderId: req.params.folderId, stage: albumStage, message: error.message }));
        res.status(500).json({ error: error.message, stage: albumStage, folderId: req.params.folderId });
    }
});

// Mutable album metadata is kept separate from paged image data. This lets
// the image pages use a short public cache without exposing stale selections
// or notes through that cache.
app.get('/api/album/:folderId/meta', async (req, res) => {
    const { folderId } = req.params;
    try {
        await loadPersistentState();
        if (bannedAlbums.includes(folderId)) return res.status(403).json({ success: false, error: 'Album đã bị hủy.' });
        if (!Object.prototype.hasOwnProperty.call(albumSettingsDatabase, folderId) && !albumCacheDatabase[folderId]) {
            return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', error: 'Không tìm thấy album.' });
        }
        issueGuestCapability(res, folderId);
        const settings = albumSettingsDatabase[folderId] || {};
        res.set('Cache-Control', 'private, no-store');
        return res.json({
            success: true,
            folderId,
            liked_list: likedImagesDatabase[folderId] || {},
            check_notes: checkNotesDatabase[folderId] || {},
            settings: publicAlbumSettings(settings),
            gallerySections: Array.isArray(settings.gallerySections) ? settings.gallerySections : [],
            isFinalized: Boolean(finalizedDatabase[folderId])
        });
    } catch (error) {
        console.error('Album metadata load failed:', JSON.stringify({ folderId, message: error.message }));
        return res.status(500).json({ success: false, error: 'Không thể tải trạng thái album.' });
    }
});

// Serve private Drive images through the album's server-side OAuth session.
// This replaces public `anyone/reader` permissions while preserving the
// existing client gallery URLs and thumbnail/preview/lightbox behavior.
app.get('/api/album/:folderId/image/:fileId', async (req, res) => {
    const { folderId, fileId } = req.params;
    const size = String(req.query?.size || 'thumb').toLowerCase();
    const width = size === 'lightbox' ? 2000 : size === 'preview' ? 1440 : 320;
    try {
        await loadPersistentState();
        const drive = await getAlbumDriveClient(folderId);
        if (!drive) return res.status(503).json({ success: false, error: 'Album chưa có phiên Google Drive hợp lệ.' });
        const settings = albumSettingsDatabase[folderId] || {};
        const allowedParents = new Set([
            normalizeDriveFolderId(settings.originalFolderId, ''),
            normalizeDriveFolderId(settings.checkFolderId, ''),
            normalizeDriveFolderId(folderId, ''),
            ...(Array.isArray(settings.gallerySections) ? settings.gallerySections.map(section => normalizeDriveFolderId(section?.driveFolderId || section?.id, '')) : [])
        ].filter(Boolean));
        const metadataKey = `${folderId}:${fileId}`;
        const cachedMetadata = driveImageMetadataCache.get(metadataKey);
        let file;
        if (cachedMetadata && cachedMetadata.expiresAt > Date.now()) {
            file = cachedMetadata.file;
        } else {
            const metadata = await drive.files.get({ fileId, fields: 'id,name,mimeType,size,parents,thumbnailLink', supportsAllDrives: true });
            file = metadata.data;
            if (file?.id) {
                driveImageMetadataCache.set(metadataKey, { file, expiresAt: Date.now() + DRIVE_IMAGE_METADATA_TTL_MS });
                if (driveImageMetadataCache.size > 3000) {
                    const firstKey = driveImageMetadataCache.keys().next().value;
                    if (firstKey) driveImageMetadataCache.delete(firstKey);
                }
            }
        }
        if (!file?.id || !/^image\/(jpeg|png|webp|gif)$/i.test(String(file.mimeType || '')) || !file.parents?.some(parent => allowedParents.has(parent))) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy ảnh trong album.' });
        }

        const isDownload = String(req.query?.download || '') === '1';
        const directDownloadsEnabled = isDownload && isSupabaseConfigured() && process.env.FINDER_DIRECT_DOWNLOADS !== '0';
        let storageReady = false;
        const objectPath = storageObjectPath(folderId, fileId);
        if (directDownloadsEnabled) {
            storageReady = await ensureDownloadBucket();
            if (storageReady) {
                const signedUrl = await createDownloadSignedUrl(objectPath, file.name || 'finder-image');
                if (signedUrl) {
                    res.set('Cache-Control', 'private, no-store');
                    return res.redirect(302, signedUrl);
                }
            }
        }
        // Persist only small grid thumbnails by default. The cache is
        // disposable; Google Drive remains the source of truth and originals
        // never enter this bucket.
        const thumbnailCacheEnabled = !isDownload
            && String(process.env.FINDER_THUMBNAIL_CACHE || '1') !== '0'
            && size === 'thumb'
            && isSupabaseConfigured();
        const thumbnailBucket = thumbnailStorageBucket();
        const thumbnailPath = thumbnailObjectPath(folderId, fileId);
        let thumbnailStorageReady = false;
        if (thumbnailCacheEnabled) {
            thumbnailStorageReady = await ensureThumbnailBucket();
            if (thumbnailStorageReady && !isKnownStorageMiss(thumbnailBucket, thumbnailPath)) {
                const cachedThumbnailUrl = await createStorageSignedUrl(thumbnailBucket, thumbnailPath, thumbnailSignTtlSeconds());
                if (cachedThumbnailUrl) {
                    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
                    return res.redirect(302, cachedThumbnailUrl);
                }
                markStorageMiss(thumbnailBucket, thumbnailPath);
            }
        }
        // Album links are public by design; cache thumbnails at the Vercel edge
        // so a large gallery does not re-download the same bytes per visitor.
        // Original downloads remain private and are never cached.
        // Preview/lightbox responses are immutable for a Drive file id. Keep
        // them at the Vercel edge for an hour (and serve stale while refreshing)
        // so repeat lightbox opens do not wait on a Drive metadata request.
        res.set('Cache-Control', isDownload ? 'private, no-store' : 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
        if (isDownload) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'finder-image')}`);

        // Drive's thumbnail link is much lighter than the original image. It
        // is fetched with the server-side OAuth bearer token, so the browser
        // never needs public Drive access.
        if (!isDownload && file.thumbnailLink) {
            const oauth = await getAlbumDriveAuth(folderId);
            const access = oauth ? await oauth.getAccessToken() : null;
            if (access?.token) {
                const thumbnailUrl = String(file.thumbnailLink).replace(/=s\d+$/i, `=s${width}`);
                const thumbnailResponse = await fetch(thumbnailUrl, { headers: { Authorization: `Bearer ${access.token}` } });
                if (thumbnailResponse.ok) {
                    const thumbnailBuffer = Buffer.from(await thumbnailResponse.arrayBuffer());
                    res.type(file.mimeType);
                    res.send(thumbnailBuffer);
                    if (thumbnailStorageReady) {
                        cacheBufferToStorage(thumbnailBucket, thumbnailPath, thumbnailBuffer, file.mimeType)
                            .catch(error => logStructuredEvent('thumbnail_cache.upload_error', { folderId, fileId, message: error.message }));
                    }
                    return;
                }
            }
        }

        const media = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
        res.set('Content-Type', file.mimeType || media.headers?.['content-type'] || 'application/octet-stream');
        if (file.size) res.set('Content-Length', String(file.size));
        media.data.on('error', error => { if (!res.headersSent) res.status(502).json({ success: false, error: 'Không thể đọc ảnh từ Google Drive.' }); });
        if (storageReady) {
            // Tee the first download: the visitor receives the image now while
            // Supabase Storage receives a bounded stream for future signed URL
            // downloads. No full image is buffered in the Vercel function.
            const storageStream = new PassThrough();
            const clientStream = new PassThrough();
            storageStream.on('error', () => {});
            cacheDriveStreamToStorage(storageStream, file, objectPath).catch(error => {
                logStructuredEvent('download_storage.upload_error', { folderId, fileId, message: error.message });
            });
            media.data.pipe(storageStream);
            media.data.pipe(clientStream);
            return clientStream.pipe(res);
        }
        media.data.pipe(res);
    } catch (error) {
        console.error('Drive image proxy failed:', JSON.stringify({ folderId, fileId, size, code: error.code, message: error.message }));
        res.status(error.code === 404 ? 404 : 502).json({ success: false, error: 'Không thể tải ảnh từ Google Drive.' });
    }
});

app.post('/api/album/:folderId/drive-token', async (req, res) => {
    await loadPersistentState();
    if (!(await requireAlbumManagementOrDriveBootstrap(req, res, req.params.folderId))) return;
    if ((!firebaseDb && !isSupabaseConfigured()) || !req.body?.tokens) return res.status(503).json({ error: 'Chưa cấu hình kho dữ liệu hoặc thiếu token.' });
    const metadata = req.body?.driveFolderId || req.body?.galleryType || req.body?.gallerySections
        ? { driveFolderId: normalizeDriveFolderId(req.body.driveFolderId, ''), galleryType: req.body.galleryType || 'selection', gallerySections: Array.isArray(req.body.gallerySections) ? req.body.gallerySections : [] }
        : null;
    const stored = { ...req.body.tokens, ...(metadata ? { _finderMeta: metadata } : {}) };
    try {
        await persistDriveTokenRecord(req.params.folderId, stored);
        res.json({ success: true, encrypted: true });
    } catch (error) {
        const code = error.message === 'TOKEN_ENCRYPTION_NOT_CONFIGURED' ? 'TOKEN_ENCRYPTION_NOT_CONFIGURED' : 'DRIVE_TOKEN_STORE_FAILED';
        res.status(503).json({ success: false, code, error: code === 'TOKEN_ENCRYPTION_NOT_CONFIGURED' ? 'Máy chủ chưa cấu hình khóa mã hóa token Drive.' : 'Không thể lưu phiên Google Drive an toàn.' });
    }
});

app.post('/api/album/:folderId/toggle-like', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!albumExists(folderId)) return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', error: 'Không tìm thấy album.' });
    if (!requireGuestCapability(req, res, folderId)) return;
    if (finalizedDatabase[folderId]) return res.status(403).json({ error: "Album đã chốt, không thể thay đổi." }); 
    const { fileName, isLiked, note } = req.body;
    if (!isSafePublicImageName(fileName)) return res.status(400).json({ error: "Tên ảnh không hợp lệ." });
    if (!likedImagesDatabase[folderId]) likedImagesDatabase[folderId] = {};

    // Luôn kiểm tra ở server để không thể vượt giới hạn chỉ bằng cách gọi API trực tiếp.
    const maxSelections = Number(albumSettingsDatabase[folderId]?.maxSelections) || 0;
    const existingLike = likedImagesDatabase[folderId][fileName];
    const wasLiked = typeof existingLike === 'object' ? !!existingLike?.isLiked : !!existingLike;
    if (isLiked && !wasLiked && maxSelections > 0) {
        const selectedCount = Object.values(likedImagesDatabase[folderId])
            .filter(item => (typeof item === 'object' ? item.isLiked : item)).length;
        if (selectedCount >= maxSelections) {
            return res.status(400).json({
                success: false,
                code: 'SELECTION_LIMIT_REACHED',
                error: `Album này chỉ cho phép chọn tối đa ${maxSelections} ảnh.`
            });
        }
    }
    likedImagesDatabase[folderId][fileName] = { isLiked, note: note || "" };
    await persistState(folderId);
    res.json({ success: true });
});

// Ghi chú hậu kỳ được tách khỏi thao tác chọn ảnh, vì album đã chốt vẫn phải
// cho khách gửi yêu cầu chỉnh sửa thêm mà không mở lại danh sách lựa chọn.
app.post('/api/album/:folderId/check-note', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!albumExists(folderId)) return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', error: 'Không tìm thấy album.' });
    if (!requireGuestCapability(req, res, folderId)) return;
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
    if (!isSafePublicImageName(fileName)) return res.status(400).json({ success: false, error: 'Tên ảnh không hợp lệ.' });
    if (!checkNotesDatabase[folderId]) checkNotesDatabase[folderId] = {};
    checkNotesDatabase[folderId][fileName] = String(req.body?.note || '').trim();
    if (checkNotesDatabase[folderId][fileName]) {
        const settings = albumSettingsDatabase[folderId] || {};
        settings.checkNeedsRevision = true;
        settings.lastCheckNoteAt = new Date().toISOString();
        settings.workflowStatus = 'revision_requested';
        albumSettingsDatabase[folderId] = settings;
    }
    await persistState(folderId);
    res.json({ success: true, note: checkNotesDatabase[folderId][fileName] });
});

app.get('/api/album/:folderId/liked/all', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!albumExists(folderId)) return res.status(404).json({ success: false, code: 'ALBUM_NOT_FOUND', error: 'Không tìm thấy album.' });
    if (!hasAlbumManagementAccess(req, folderId) && !requireGuestCapability(req, res, folderId, { issueOnGet: true })) return;
    const currentAlbumLikes = likedImagesDatabase[folderId] || {};
    const isFinalized = !!finalizedDatabase[folderId];
    const likedFilesMap = {};
    
    Object.keys(currentAlbumLikes).forEach(key => {
        const item = currentAlbumLikes[key];
        const isLiked = typeof item === 'object' ? item.isLiked : item;
        if (isLiked) likedFilesMap[key] = typeof item === 'object' ? item.note : "";
    });
    
    res.json({ success: true, folderId, liked_files: likedFilesMap, isFinalized });
});

// Express sẽ chuyển mọi lỗi bất ngờ từ các route bất đồng bộ về đây. Trả JSON
// giúp trang khách hiển thị được lý do thay vì thông báo chung chung.
app.use((error, req, res, next) => {
    const requestId = req.requestId || createRequestId();
    logStructuredEvent('api.unhandled_error', { requestId, method: req.method, path: req.path, message: error.message });
    res.status(error.status || 500).json({
        success: false,
        requestId,
        error: process.env.NODE_ENV === 'production' ? 'Máy chủ không thể xử lý yêu cầu.' : (error.message || 'Máy chủ không thể lưu dữ liệu.')
    });
});

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server FinderPicture chạy tại cổng ${PORT}`));
}

module.exports = app;
