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
            updates[key] = options.deletePartition ? null : buildAlbumPartition(changedFolderId);
        } else if (options.clearAll) {
            updates.finderPictureStateByAlbum = null;
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
            const tokenIds = Object.keys(tokenSnapshot.val() || {}).filter(id => id.slice(-6).toLowerCase() === rawTail.toLowerCase());
            for (const folderId of tokenIds) {
                try {
                    const auth = await getAlbumDriveAuth(folderId);
                    if (!auth) continue;
                    const drive = google.drive({ version: 'v3', auth });
                    const metadata = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType', supportsAllDrives: true });
                    const nameSlug = canonicalPublicSlug(metadata.data.name || '');
                    if (!baseSlug || nameSlug === baseSlug) return { folderId, folderName: metadata.data.name || 'Album khách hàng' };
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
                    fields: 'nextPageToken,files(id,name,parents)',
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
                    return { folderId: id, folderName: folder.name || 'Album khách hàng' };
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
    if (!match) {
        try {
            const recovered = await findDriveFolderByLegacySlug(requested, req.params.slug);
            if (recovered) {
                const folderId = recovered.folderId;
                const restored = {
                    isEnabled: true,
                    text: 'FINDERPICTURE STUDIO',
                    maxSelections: 0,
                    publicSlug: requested,
                    clientName: recovered.folderName,
                    displayName: 'Finder',
                    originalFolderId: null,
                    studioName: 'FINDER',
                    studioLogo: '',
                    accentColor: '#7c8cff',
                    checkReady: false,
                    checkVersion: 0,
                    checkNeedsRevision: false,
                    workflowStatus: 'selection_open'
                };
                albumSettingsDatabase[folderId] = { ...(albumSettingsDatabase[folderId] || {}), ...restored };
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
    const settings = { ...match[1], publicSlug: requested };
    res.json({ success: true, folderId: match[0], settings: publicAlbumSettings(settings) });
});

app.get('/a/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
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
    const tokens = snapshot.val();
    if (!tokens?.refresh_token && !tokens?.access_token) return null;
    const credentials = process.env.GOOGLE_OAUTH_CREDENTIALS;
    if (!credentials) return null;
    const cfg = JSON.parse(credentials); const c = cfg.web || cfg.installed;
    const client = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://localhost:3000/oauth2callback');
    client.setCredentials(tokens);
    if (tokens.refresh_token && (!tokens.expiry_date || tokens.expiry_date < Date.now() + 60000)) {
        const refreshed = await client.getAccessToken();
        if (refreshed?.token) { const next = { ...tokens, access_token: refreshed.token, expiry_date: Date.now() + 3600000 }; await firebaseDb.ref(`driveTokens/${folderId}`).set(next); client.setCredentials(next); }
    }
    return client;
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
    const { isEnabled, text, maxSelections, reopenSelection, publicSlug, clientName, displayName, originalFolderId, studioName, studioLogo, accentColor, paymentStatus, paymentAmount, paymentTotal, paymentDeposit, paymentPaid, paymentBalance, paymentPayer, paymentNote } = req.body;
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
    // Firebase writes can occasionally remain open on a cold Vercel instance
    // even though the in-memory update is valid. Never hold the desktop upload
    // on that network write: return the management token immediately and let
    // the partition persist in the background. The slug resolver has a Drive
    // token fallback if this particular write is interrupted.
    persistState(folderId).catch(error => console.warn('Không thể lưu settings album:', error.message));
    res.json({ success: true, settings: albumSettingsDatabase[folderId], managementToken: albumSettingsDatabase[folderId].managementToken, persistencePending: Boolean(firebaseDb) });
});

// Gallery giao ảnh tiệc/PSC độc lập. Ảnh được đọc trực tiếp từ thư mục Drive
// đã chọn; không tạo ORIGINAL/CHECK và không đi qua luồng chọn ảnh.
app.post('/api/party-gallery', async (req, res) => {
    await loadPersistentState();
    const driveFolderId = typeof req.body?.driveFolderId === 'string' ? req.body.driveFolderId.trim() : (typeof req.body?.folderId === 'string' ? req.body.folderId.trim() : '');
    const folderId = typeof req.body?.galleryId === 'string' && req.body.galleryId.trim() ? req.body.galleryId.trim() : driveFolderId;
    if (!driveFolderId) return res.status(400).json({ success: false, error: 'Thiếu thư mục Google Drive.' });
    const galleryName = String(req.body?.galleryName || 'Ảnh tiệc').trim() || 'Ảnh tiệc';
    const studioName = String(req.body?.studioName || 'Finder').trim().toUpperCase() || 'FINDER';
    const requestedSlug = slugifyAlbumName(req.body?.publicSlug || galleryName);
    const publicSlug = canonicalPublicSlug(`${requestedSlug}-${String(folderId).slice(-6)}`);
    const expiresDays = Math.min(3650, Math.max(1, Number(req.body?.expiresDays) || 60));
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresDays * 86400000).toISOString();
    const sectionName = String(req.body?.sectionName || 'Ngày 1').trim() || 'Ngày 1';
    const managementToken = createManagementToken();
    albumSettingsDatabase[folderId] = {
        ...(albumSettingsDatabase[folderId] || {}),
        isEnabled: true,
        text: 'ẢNH TIỆC',
        maxSelections: 0,
        publicSlug,
        clientName: galleryName,
        displayName: galleryName,
        originalFolderId: driveFolderId,
        gallerySections: [{ id: driveFolderId, name: sectionName, driveFolderId, createdAt }],
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
    const driveFolderId = String(req.body?.driveFolderId || '').trim();
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
    try {
        await loadPersistentState();
        let { folderId } = req.params;
        if (bannedAlbums.includes(folderId)) return res.status(403).json({ success: false, error: "Album đã bị hủy." });

        const currentAlbumLikes = likedImagesDatabase[folderId] || {};
        let currentSettings = albumSettingsDatabase[folderId] || { isEnabled: true, text: "FINDERPICTURE STUDIO", maxSelections: 0, originalFolderId: null, checkReady: false, checkVersion: 0, checkNeedsRevision: false, workflowStatus: 'selection_open', selectionReopenedAt: null, paymentStatus: 'unpaid', paymentAmount: 0, publicSlug: `album-${String(folderId).slice(-6).toLowerCase()}`, clientName: 'Album khách hàng', studioName: 'Finder', studioLogo: '', accentColor: '#7c8cff' };
        // expiresAt hiện chỉ là mốc tham khảo để hiển thị cho khách hàng.
        // Không khóa link, không xóa album và không xóa file Google Drive tự động.
        const isFinalized = !!finalizedDatabase[folderId];
        const hasCheckFolder = Boolean(currentSettings.checkReady && currentSettings.checkFolderId);

        if (albumCacheDatabase[folderId] && albumCacheDatabase[folderId].length > 0 && (!hasCheckFolder || Object.prototype.hasOwnProperty.call(albumCheckCacheDatabase, folderId))) {
            return res.json({ success: true, folderId, files: albumCacheDatabase[folderId], checkFiles: albumCheckCacheDatabase[folderId] || [], gallerySections: currentSettings.gallerySections || [], liked_list: currentAlbumLikes, check_notes: checkNotesDatabase[folderId] || {}, settings: publicAlbumSettings(currentSettings), isFinalized });
        }

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
        const sections = currentSettings.galleryType === 'party' && Array.isArray(currentSettings.gallerySections) && currentSettings.gallerySections.length
            ? currentSettings.gallerySections
            : [{ id: currentSettings.originalFolderId || folderId, name: 'Ảnh', driveFolderId: currentSettings.originalFolderId || folderId }];
        const sectionFiles = await Promise.all(sections.map(async section => (await listDriveImages(section.driveFolderId || section.id)).map(file => ({ ...file, gallerySectionId: section.id || section.driveFolderId, gallerySectionName: section.name || 'Ảnh' }))));
        const files = sectionFiles.flat();
        const checkFiles = hasCheckFolder ? await listDriveImages(currentSettings.checkFolderId) : [];

        albumCacheDatabase[folderId] = files;
        if (hasCheckFolder) albumCheckCacheDatabase[folderId] = checkFiles;
        res.json({ success: true, folderId, files, checkFiles, gallerySections: sections, liked_list: currentAlbumLikes, check_notes: checkNotesDatabase[folderId] || {}, settings: publicAlbumSettings(currentSettings), isFinalized });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/album/:folderId/drive-token', async (req, res) => {
    if (!requireAlbumManagement(req, res, req.params.folderId)) return;
    if (!firebaseDb || !req.body?.tokens) return res.status(503).json({ error: 'Firebase chưa cấu hình hoặc thiếu token.' });
    await firebaseDb.ref(`driveTokens/${req.params.folderId}`).set(req.body.tokens);
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
