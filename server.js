const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
const driveOAuthStates = new Map();
app.use(cors());
app.use(bodyParser.json());
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
let albumCacheDatabase = {}; 
let albumSettingsDatabase = {}; 
let bannedAlbums = [];
let finalizedDatabase = {}; 
let firebaseDb = null;

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
        albumSettingsDatabase = db.albumSettingsDatabase || {};
        bannedAlbums = db.bannedAlbums || [];
        finalizedDatabase = db.finalizedDatabase || {};
    } catch (e) {}
}

function saveDB() {
    try { fs.writeFileSync(DB_PATH, JSON.stringify({ likedImagesDatabase, albumSettingsDatabase, bannedAlbums, finalizedDatabase }), 'utf8'); } catch (e) {}
}

async function loadPersistentState() {
    if (!firebaseDb) return;
    const snapshot = await firebaseDb.ref('finderPictureState').once('value');
    const state = snapshot.val();
    if (!state) return;
    likedImagesDatabase = deserializeLikedImages(state.likedImagesDatabase || {});
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

async function persistState() {
    saveDB();
    if (firebaseDb) {
        await firebaseDb.ref('finderPictureState').set({
            likedImagesDatabase: serializeLikedImages(likedImagesDatabase),
            albumSettingsDatabase,
            bannedAlbums,
            finalizedDatabase
        });
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
        res.json({ success: true, clientId: client._clientId, tokens: tokens || null });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/client.html', (req, res) => {
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

app.post('/api/auth/save-token', (req, res) => {
    const { tokens } = req.body;
    if (!tokens) return res.status(400).json({ error: "Thiếu Token" });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.json({ success: true });
});

app.post('/api/album/:folderId/settings', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    const { isEnabled, text, maxSelections } = req.body;
    
    if(!albumSettingsDatabase[folderId]) {
        albumSettingsDatabase[folderId] = { 
            isEnabled: isEnabled !== undefined ? isEnabled : true, 
            text: text || "FINDERPICTURE STUDIO", 
            maxSelections: parseInt(maxSelections) || 0 
        };
    } else {
        if (isEnabled !== undefined) albumSettingsDatabase[folderId].isEnabled = isEnabled;
        if (text !== undefined) albumSettingsDatabase[folderId].text = text;
        if (maxSelections !== undefined) albumSettingsDatabase[folderId].maxSelections = parseInt(maxSelections) || 0;
    }
    await persistState();
    res.json({ success: true });
});

app.post('/api/album/:folderId/finalize', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    finalizedDatabase[folderId] = true;
    await persistState();
    res.json({ success: true });
});

app.delete('/api/album/:folderId', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    if (!bannedAlbums.includes(folderId)) bannedAlbums.push(folderId);
    delete albumCacheDatabase[folderId];
    delete likedImagesDatabase[folderId];
    delete albumSettingsDatabase[folderId];
    delete finalizedDatabase[folderId];
    await persistState();
    res.json({ success: true, message: "Album đã bị hủy!" });
});

app.delete('/api/album/flush-all/data', async (req, res) => {
    albumCacheDatabase = {}; likedImagesDatabase = {}; albumSettingsDatabase = {}; finalizedDatabase = {};
    await persistState();
    res.json({ success: true, message: "All data cleared" });
});

app.get('/api/album/:folderId', async (req, res) => {
    try {
        await loadPersistentState();
        let { folderId } = req.params;
        if (bannedAlbums.includes(folderId)) return res.status(403).json({ success: false, error: "Album đã bị hủy." });

        const currentAlbumLikes = likedImagesDatabase[folderId] || {};
        const currentSettings = albumSettingsDatabase[folderId] || { isEnabled: true, text: "FINDERPICTURE STUDIO", maxSelections: 0 };
        const isFinalized = !!finalizedDatabase[folderId];

        if (albumCacheDatabase[folderId] && albumCacheDatabase[folderId].length > 0) {
            return res.json({ success: true, folderId, files: albumCacheDatabase[folderId], liked_list: currentAlbumLikes, settings: currentSettings, isFinalized });
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

        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            includeItemsFromAllDrives: true, supportsAllDrives: true,
            fields: 'files(id, name, webContentLink, thumbnailLink)',
            pageSize: 500
        });

        // Drive tạo thumbnail theo kích thước được yêu cầu, nên trang khách chỉ tải
        // đúng số pixel cần hiển thị thay vì tải ảnh gốc dung lượng lớn.
        const driveThumbnail = (fileId, width) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`;
        const files = (response.data.files || []).map(file => {
            const nameWithoutExt = path.basename(file.name, path.extname(file.name));
            return {
                id: file.id,
                fullName: file.name,
                shortName: nameWithoutExt,
                thumbnail: driveThumbnail(file.id, 320),
                preview: driveThumbnail(file.id, 1440),
                lightbox: driveThumbnail(file.id, 2200),
                originalUrl: file.webContentLink
            };
        });

        albumCacheDatabase[folderId] = files;
        res.json({ success: true, folderId, files, liked_list: currentAlbumLikes, settings: currentSettings, isFinalized });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/album/:folderId/drive-token', async (req, res) => {
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
    await persistState();
    res.json({ success: true });
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
        error: error.message || 'Máy chủ không thể lưu dữ liệu.'
    });
});

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server FinderPicture chạy tại cổng ${PORT}`));
}

module.exports = app;
