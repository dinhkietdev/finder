const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
app.disable('x-powered-by');
const driveOAuthStates = new Map();
const allowedOrigins = String(process.env.FINDER_ALLOWED_ORIGINS || 'https://finder-swart-pi.vercel.app,http://localhost:5000,http://localhost:3000')
    .split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({ origin(origin, callback) {
    // Native desktop requests do not include Origin; keep them working.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin không được phép.'));
} }));
app.use(bodyParser.json({ limit: process.env.FINDER_JSON_LIMIT || '256kb' }));

// Lightweight per-instance rate limiting. Vercel instances are ephemeral, so
// this is not a replacement for an edge/WAF limit, but it prevents accidental
// request storms and repeated OAuth attempts on a single instance.
const requestBuckets = new Map();
app.use('/api/', (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path.startsWith('/auth/') ? 'auth' : 'api'}`;
    const now = Date.now();
    const bucket = requestBuckets.get(key) || { start: now, count: 0 };
    if (now - bucket.start > 60_000) { bucket.start = now; bucket.count = 0; }
    bucket.count += 1;
    requestBuckets.set(key, bucket);
    if (bucket.count > (key.endsWith(':auth') ? 30 : 240)) return res.status(429).json({ success: false, error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' });
    if (requestBuckets.size > 5000) for (const [entry, value] of requestBuckets) if (now - value.start > 120_000) requestBuckets.delete(entry);
    next();
});

// Credential/session files are only for local development. Keep them out of
// the public static file handler even if a local deployment directory contains
// one by mistake.
app.use((req, res, next) => {
    if (/^\/(?:oauth-credentials|session-token|database)\.json$/.test(req.path)) {
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

const TOKEN_PATH = path.join(__dirname, 'session-token.json');
const DB_PATH = path.join(__dirname, 'database.json'); 

let likedImagesDatabase = {};
let checkNotesDatabase = {};
let albumCacheDatabase = {}; 
let albumCheckCacheDatabase = {};
let albumSettingsDatabase = {}; 
let bannedAlbums = [];
let finalizedDatabase = {}; 
let firebaseDb = null;
let firebaseMigrationPromise = null;

function createManagementToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hasAlbumManagementAccess(req, folderId) {
    const settings = albumSettingsDatabase[folderId];
    // Legacy albums created before management tokens remain compatible. New
    // albums receive a token on their first desktop settings write.
    if (!settings?.managementToken) return true;
    const supplied = String(req.get('x-finder-management-token') || req.body?.managementToken || '');
    return supplied.length === settings.managementToken.length
        && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(settings.managementToken));
}

function requireAlbumManagement(req, res, folderId) {
    if (hasAlbumManagementAccess(req, folderId)) return true;
    res.status(403).json({ success: false, error: 'Không có quyền quản lý album này.' });
    return false;
}

function publicAlbumSettings(settings = {}) {
    const { managementToken, ...safeSettings } = settings;
    return safeSettings;
}

function firebaseAlbumKey(folderId) {
    return Buffer.from(String(folderId), 'utf8').toString('base64url');
}

function buildAlbumPartition(folderId) {
    return {
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

// Vercel không giữ được file giữa các lần chạy. Khi cấu hình Firebase, toàn bộ
// trạng thái album sẽ được lưu bền vững; máy local vẫn có thể dùng database.json.
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

if (fs.existsSync(DB_PATH)) {
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
    if (!firebaseDb) return;
    const key = `finderPictureStateByAlbum/${firebaseAlbumKey(folderId)}`;
    const settings = albumSettingsDatabase[folderId] || null;
    const updates = {
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
    if (!firebaseDb) return;
    await ensureFirebaseMigration();
    // Read album partitions first. The old aggregate node is retained as a
    // migration/rollback source and only used for legacy fallback.
    const partitionsSnapshot = await firebaseDb.ref('finderPictureStateByAlbum').once('value');
    const partitions = partitionsSnapshot.val();
    if (partitions && Object.keys(partitions).length) {
        const liked = {}, notes = {}, settings = {}, finalized = {}, banned = [];
        for (const partition of Object.values(partitions)) {
            const folderId = String(partition?.folderId || '');
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
        const state = require('crypto').randomBytes(24).toString('hex');
        driveOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
        // Do not force Google's consent page on every recovery attempt. The
        // first grant still returns an offline refresh token; later attempts
        // only select the account unless Google genuinely needs consent again.
        res.json({ success: true, clientId: client._clientId, authUrl: client.generateAuthUrl({ access_type:'offline', prompt:'select_account', state, scope:['https://www.googleapis.com/auth/drive'] }) });
    } catch (error) { res.status(500).json({ error: error.message }); }
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

// Link chia sẻ ngắn gọn, giữ nguyên URL cũ để các album đã gửi trước đây không
// bị hỏng. Client sẽ tự resolve slug thành folderId mà không làm lộ mã Drive trên
// thanh địa chỉ.
function slugifyAlbumName(value = '') {
    return String(value)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'album';
}

// Older desktop builds appended the raw last characters of a Drive id. Drive
// ids may contain `_`, which is intentionally normalized by slugifyAlbumName;
// compare the stored value in the same canonical form so existing links keep
// working after the desktop is updated.
function canonicalPublicSlug(value = '') {
    return slugifyAlbumName(value);
}

function normalizeDriveFolderId(value, fallback = '') {
    const id = String(value || '').trim();
    if (!id || id === '.' || id === '..') return String(fallback || '').trim();
    return id;
}

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
    res.json({ success: true, folderId: match[0], settings: publicAlbumSettings(settings) });
});

function escapeHtmlAttribute(value = '') {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

// Social crawlers (Messenger/Zalo) do not execute the client JavaScript. Add
// server-rendered Open Graph values so a shared album is presented as Finder
// instead of an opaque URL. The gallery page itself remains unchanged.
app.get('/a/:slug', async (req, res) => {
    try {
        await loadPersistentState();
        const requested = canonicalPublicSlug(req.params.slug);
        const match = Object.values(albumSettingsDatabase).find(settings => canonicalPublicSlug(settings?.publicSlug) === requested);
        const studio = String(match?.studioName || 'Finder').trim().toUpperCase() || 'FINDER';
        const title = `${studio} · Gallery ảnh`;
        const description = match?.galleryType === 'party' ? 'Gallery ảnh tiệc / PSC trên Finder' : 'Gallery ảnh khách hàng trên Finder';
        const source = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
        const canonicalUrl = `https://${process.env.ONLINE_DOMAIN || 'finder-swart-pi.vercel.app'}/a/${encodeURIComponent(req.params.slug)}`;
        const meta = `<meta property="og:title" content="${escapeHtmlAttribute(title)}"><meta property="og:description" content="${escapeHtmlAttribute(description)}"><meta property="og:type" content="website"><meta property="og:site_name" content="FINDER"><meta property="og:url" content="${escapeHtmlAttribute(canonicalUrl)}"><meta name="twitter:card" content="summary">`;
        const withoutStaticSocialMeta = source
            .replace(/\s*<meta property="og:[^"]+" content="[^"]*">/g, '')
            .replace(/\s*<meta name="twitter:card" content="[^"]*">/g, '');
        return res.type('html').send(withoutStaticSocialMeta.replace('</head>', `${meta}</head>`));
    } catch (_) {
        return res.sendFile(path.join(__dirname, 'client.html'));
    }
});

app.post('/api/auth/drive-exchange', async (req, res) => {
    const { code, state } = req.body || {};
    if (!code || !driveOAuthStates.has(state) || driveOAuthStates.get(state) < Date.now()) return res.status(400).json({ error: 'Yêu cầu OAuth không hợp lệ hoặc đã hết hạn.' });
    driveOAuthStates.delete(state);
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
    if (!firebaseDb) return null;
    const snapshot = await firebaseDb.ref(`driveTokens/${folderId}`).once('value');
    const stored = snapshot.val();
    const metadata = stored?._finderMeta || {};
    const tokens = stored ? { ...stored } : null;
    if (tokens) delete tokens._finderMeta;
    if (!tokens?.refresh_token && !tokens?.access_token) return null;
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
            await firebaseDb.ref(`driveTokens/${folderId}`).set(next);
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

app.post('/api/album/:folderId/settings', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!requireAlbumManagement(req, res, folderId)) return;
    const { isEnabled, text, maxSelections, reopenSelection, publicSlug, clientName, displayName, originalFolderId, studioName, studioLogo, accentColor, paymentStatus, paymentAmount, paymentTotal, paymentDeposit, paymentPaid, paymentBalance, paymentPayer, paymentNote, galleryType, partyGallery, gallerySections, expiresDays, expiresAt } = req.body;
    const hasLimitUpdate = maxSelections !== undefined;
    const previousLimit = albumSettingsDatabase[folderId]?.maxSelections;
    const nextLimit = hasLimitUpdate ? (parseInt(maxSelections) || 0) : previousLimit;
    
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
        if (maxSelections !== undefined) albumSettingsDatabase[folderId].maxSelections = nextLimit;
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
        if (studioName !== undefined) albumSettingsDatabase[folderId].studioName = String(studioName || 'Finder').trim().toUpperCase();
        if (studioLogo !== undefined) albumSettingsDatabase[folderId].studioLogo = studioLogo;
        if (accentColor !== undefined) albumSettingsDatabase[folderId].accentColor = accentColor;
    }
    // Khi admin thay đổi hạn mức, khách cần được mở lại album để bổ sung
    // lựa chọn. Dữ liệu likedImagesDatabase vẫn giữ nguyên, chỉ bỏ trạng thái
    // đã chốt; vì vậy các ảnh cũ không bị mất và server nhận được ảnh mới.
    const isBackgroundSync = req.get('x-finder-background-sync') === '1';
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
    if (firebaseDb) {
        try {
            await Promise.race([
                persistAlbumSettings(folderId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase settings write timeout')), 7000))
            ]);
        } catch (error) {
            persistencePending = true;
            console.warn('Không thể lưu settings album:', JSON.stringify({ message: error.message, code: error.code }));
        }
    }
    res.json({ success: true, settings: publicAlbumSettings(albumSettingsDatabase[folderId]), managementToken: albumSettingsDatabase[folderId].managementToken, persistencePending, driveBrandingSaved });
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
    if (!requireAlbumManagement(req, res, folderId)) return;
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
    res.json({
        success: true,
        settings: publicAlbumSettings(albumSettingsDatabase[folderId] || { isEnabled: true, text: 'FINDERPICTURE STUDIO', maxSelections: 0, originalFolderId: null, checkReady: false, checkVersion: 0, checkNeedsRevision: false, workflowStatus: 'selection_open', selectionReopenedAt: null, paymentStatus: 'unpaid', paymentAmount: 0, publicSlug: `album-${String(folderId).slice(-6).toLowerCase()}`, clientName: 'Album khách hàng', displayName: 'Finder', studioName: 'Finder', studioLogo: '', accentColor: '#7c8cff' }),
        isFinalized: !!finalizedDatabase[folderId]
    });
});

app.post('/api/album/:folderId/check', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!requireAlbumManagement(req, res, folderId)) return;
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

        if (albumCacheDatabase[folderId] && albumCacheDatabase[folderId].length > 0 && (!hasCheckFolder || Object.prototype.hasOwnProperty.call(albumCheckCacheDatabase, folderId))) {
            return res.json({ success: true, folderId, files: albumCacheDatabase[folderId], checkFiles: albumCheckCacheDatabase[folderId] || [], gallerySections: currentSettings.gallerySections || [], liked_list: currentAlbumLikes, check_notes: checkNotesDatabase[folderId] || {}, settings: publicAlbumSettings(currentSettings), isFinalized });
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
        const driveStudioName = brandingFolderId ? await readDriveBranding(drive, brandingFolderId) : null;
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
        const driveThumbnail = (fileId, width) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`;
        const toClientFile = file => {
            const nameWithoutExt = path.basename(file.name, path.extname(file.name));
            return {
                id: file.id,
                fullName: file.name,
                shortName: nameWithoutExt,
                thumbnail: driveThumbnail(file.id, 320),
                preview: driveThumbnail(file.id, 1440),
                // Lightbox dùng thumbnail lớn của Drive để cân bằng độ nét và
                // tốc độ tải. Không tải file gốc dung lượng lớn khi khách mở ảnh.
                lightbox: driveThumbnail(file.id, 2000),
                originalUrl: file.webContentLink
            };
        };
        const listDriveImages = async parentId => {
            const files = [];
            let pageToken;
            do {
                const response = await drive.files.list({
                    q: `'${parentId}' in parents and trashed = false`,
                    includeItemsFromAllDrives: true, supportsAllDrives: true,
                    fields: 'nextPageToken,files(id, name, webContentLink, thumbnailLink)',
                    pageSize: 1000, pageToken
                });
                files.push(...(response.data.files || []));
                pageToken = response.data.nextPageToken || undefined;
            } while (pageToken);
            return files.filter(file => /\.(jpe?g|png|webp)$/i.test(file.name || '')).map(toClientFile);
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
        albumStage = 'list-gallery-images';
        const sectionFiles = await Promise.all(sections.map(async section => (await listDriveImages(section.driveFolderId)).map(file => ({ ...file, gallerySectionId: section.id || section.driveFolderId, gallerySectionName: section.name || 'Ảnh' }))));
        const files = sectionFiles.flat();
        albumStage = 'list-check-images';
        const checkFiles = hasCheckFolder ? await listDriveImages(safeCheckFolderId) : [];

        albumCacheDatabase[folderId] = files;
        if (hasCheckFolder) albumCheckCacheDatabase[folderId] = checkFiles;
        res.json({ success: true, folderId, files, checkFiles, gallerySections: sections, liked_list: currentAlbumLikes, check_notes: checkNotesDatabase[folderId] || {}, settings: publicAlbumSettings(currentSettings), isFinalized });
    } catch (error) {
        console.error('Album load failed:', JSON.stringify({ folderId: req.params.folderId, stage: albumStage, message: error.message }));
        res.status(500).json({ error: error.message, stage: albumStage, folderId: req.params.folderId });
    }
});

app.post('/api/album/:folderId/drive-token', async (req, res) => {
    if (!requireAlbumManagement(req, res, req.params.folderId)) return;
    if (!firebaseDb || !req.body?.tokens) return res.status(503).json({ error: 'Firebase chưa cấu hình hoặc thiếu token.' });
    const metadata = req.body?.driveFolderId || req.body?.galleryType || req.body?.gallerySections
        ? { driveFolderId: normalizeDriveFolderId(req.body.driveFolderId, ''), galleryType: req.body.galleryType || 'selection', gallerySections: Array.isArray(req.body.gallerySections) ? req.body.gallerySections : [] }
        : null;
    await firebaseDb.ref(`driveTokens/${req.params.folderId}`).set({ ...req.body.tokens, ...(metadata ? { _finderMeta: metadata } : {}) });
    res.json({ success: true });
});

app.post('/api/album/:folderId/toggle-like', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (finalizedDatabase[folderId]) return res.status(403).json({ error: "Album đã chốt, không thể thay đổi." }); 
    const { fileName, isLiked, note } = req.body;
    if (!fileName || typeof fileName !== 'string') return res.status(400).json({ error: "Tên ảnh không hợp lệ." });
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
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
    if (!fileName) return res.status(400).json({ success: false, error: 'Tên ảnh không hợp lệ.' });
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
    console.error('API error:', error);
    res.status(error.status || 500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' ? 'Máy chủ không thể xử lý yêu cầu.' : (error.message || 'Máy chủ không thể lưu dữ liệu.')
    });
});

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server FinderPicture chạy tại cổng ${PORT}`));
}

module.exports = app;
