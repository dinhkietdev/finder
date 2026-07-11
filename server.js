const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');

const app = express();
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
let firebaseAuth = null;
const driveOAuthStates = new Map();

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
        firebaseAuth = getAuth(firebaseApp);
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

function getOAuth2Client(redirectUri) {
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

function getGoogleClientId() {
    try {
        const credentials = process.env.GOOGLE_OAUTH_CREDENTIALS
            ? JSON.parse(process.env.GOOGLE_OAUTH_CREDENTIALS)
            : JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth-credentials.json'), 'utf8'));
        return (credentials.installed || credentials.web)?.client_id || null;
    } catch (error) { return null; }
}

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

async function getStoredTokensForStudio(studioId) {
    if (studioId && firebaseDb) {
        const tokens = (await firebaseDb.ref(`finderStudios/${studioId}/googleDriveTokens`).once('value')).val();
        if (tokens) return tokens;
    }
    // Chỉ giữ fallback này cho album cũ được tạo trước khi có Studio_ID.
    return getStoredTokens();
}

async function refreshDriveTokens(tokens) {
    if (!tokens?.refresh_token) return tokens;
    const oauth2Client = getOAuth2Client('http://localhost:3000/oauth2callback');
    if (!oauth2Client) return tokens;
    oauth2Client.setCredentials(tokens);
    const refreshed = await oauth2Client.getAccessToken();
    if (refreshed?.token) return { ...tokens, access_token: refreshed.token, expiry_date: Date.now() + 3600 * 1000 };
    return tokens;
}

const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',')
    .map(email => email.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean));

async function getStudioProfile(uid) {
    if (!firebaseDb) return null;
    const snapshot = await firebaseDb.ref(`finderStudios/${uid}`).once('value');
    return snapshot.val();
}

async function requireStudioUser(req, res, next) {
    try {
        if (!firebaseAuth || !firebaseDb) return res.status(503).json({ error: 'Máy chủ chưa cấu hình Firebase Authentication.' });
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!token) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
        const user = await firebaseAuth.verifyIdToken(token);
        const ref = firebaseDb.ref(`finderStudios/${user.uid}`);
        let studio = (await ref.once('value')).val();
        if (!studio) {
            const isAdmin = adminEmails.has((user.email || '').toLowerCase());
            studio = { id: user.uid, email: user.email || '', name: '', status: isAdmin ? 'active' : 'pending', role: isAdmin ? 'admin' : 'studio', createdAt: new Date().toISOString() };
            await ref.set(studio);
        } else if (adminEmails.has((user.email || '').toLowerCase()) && (studio.role !== 'admin' || studio.status !== 'active')) {
            studio = { ...studio, role: 'admin', status: 'active', email: user.email || studio.email || '' };
            await ref.update({ role: 'admin', status: 'active', email: studio.email });
        }
        req.user = user; req.studio = studio; next();
    } catch (error) { res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ.' }); }
}

function requireApprovedStudio(req, res, next) {
    if (req.studio?.status !== 'active') return res.status(403).json({ error: 'Tài khoản studio đang chờ xét duyệt.', status: req.studio?.status || 'pending' });
    next();
}

function requireAdmin(req, res, next) {
    if (req.studio?.role !== 'admin') return res.status(403).json({ error: 'Chỉ quản trị viên có quyền thực hiện thao tác này.' });
    next();
}

app.post('/api/auth/session', requireStudioUser, async (req, res) => {
    const studioName = String(req.body?.studioName || '').trim();
    if (studioName && !req.studio.name) {
        req.studio.name = studioName;
        await firebaseDb.ref(`finderStudios/${req.user.uid}/name`).set(studioName);
    }
    res.json({ success: true, studio: req.studio });
});

app.get('/api/admin/studios', requireStudioUser, requireApprovedStudio, requireAdmin, async (req, res) => {
    const studios = (await firebaseDb.ref('finderStudios').once('value')).val() || {};
    res.json({ success: true, studios: Object.values(studios).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) });
});

app.post('/api/admin/studios/:studioId/approval', requireStudioUser, requireApprovedStudio, requireAdmin, async (req, res) => {
    const status = req.body?.status === 'rejected' ? 'rejected' : 'active';
    await firebaseDb.ref(`finderStudios/${req.params.studioId}`).update({ status, approvedAt: new Date().toISOString(), approvedBy: req.user.uid });
    res.json({ success: true, status });
});

app.post('/api/auth/save-token', requireStudioUser, requireApprovedStudio, async (req, res) => {
    const { tokens } = req.body;
    if (!tokens) return res.status(400).json({ error: "Thiếu Token" });
    await firebaseDb.ref(`finderStudios/${req.user.uid}/googleDriveTokens`).set(tokens);
    res.json({ success: true });
});

app.get('/api/auth/drive-token', requireStudioUser, requireApprovedStudio, async (req, res) => {
    let tokens = (await firebaseDb.ref(`finderStudios/${req.user.uid}/googleDriveTokens`).once('value')).val();
    if (tokens?.refresh_token) {
        try {
            tokens = await refreshDriveTokens(tokens);
            await firebaseDb.ref(`finderStudios/${req.user.uid}/googleDriveTokens`).set(tokens);
        } catch (error) { console.warn('Không thể refresh Google Drive token:', error.message); }
    }
    res.json({ success: true, tokens: tokens || null, clientId: getGoogleClientId() });
});

// Desktop chỉ nhận client_id công khai. Client secret luôn ở Vercel và chỉ dùng
// để đổi authorization code thành token sau khi người dùng đã đăng nhập Finder.
app.post('/api/auth/drive-authorize', requireStudioUser, requireApprovedStudio, async (req, res) => {
    const redirectUri = 'http://localhost:3000/oauth2callback';
    const oauth2Client = getOAuth2Client(redirectUri);
    if (!oauth2Client) return res.status(503).json({ error: 'Máy chủ chưa cấu hình Google Drive OAuth.' });
    const state = crypto.randomBytes(32).toString('base64url');
    driveOAuthStates.set(state, { uid: req.user.uid, expiresAt: Date.now() + 10 * 60 * 1000 });
    const requireFullDriveScope = !!req.body?.requireFullDriveScope;
    res.json({
        success: true,
        clientId: getGoogleClientId(),
        authUrl: oauth2Client.generateAuthUrl({
            access_type: 'offline', prompt: 'consent', state,
            scope: [requireFullDriveScope ? 'https://www.googleapis.com/auth/drive' : 'https://www.googleapis.com/auth/drive.file']
        })
    });
});

app.post('/api/auth/drive-exchange', requireStudioUser, requireApprovedStudio, async (req, res) => {
    const { state, code } = req.body || {};
    const request = driveOAuthStates.get(state);
    driveOAuthStates.delete(state);
    if (!request || request.uid !== req.user.uid || request.expiresAt < Date.now()) return res.status(400).json({ error: 'Yêu cầu xác thực Google Drive đã hết hạn.' });
    if (!code) return res.status(400).json({ error: 'Thiếu mã xác thực Google Drive.' });
    try {
        const oauth2Client = getOAuth2Client('http://localhost:3000/oauth2callback');
        const { tokens } = await oauth2Client.getToken(code);
        await firebaseDb.ref(`finderStudios/${req.user.uid}/googleDriveTokens`).set(tokens);
        res.json({ success: true, tokens, clientId: getGoogleClientId() });
    } catch (error) { res.status(400).json({ error: `Không thể xác thực Google Drive: ${error.message}` }); }
});

app.post('/api/album/:folderId/settings', requireStudioUser, requireApprovedStudio, async (req, res) => {
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
    await firebaseDb.ref(`finderAlbumOwners/${folderId}`).set(req.user.uid);
    res.json({ success: true });
});

app.post('/api/album/:folderId/finalize', async (req, res) => {
    await loadPersistentState();
    const { folderId } = req.params;
    const previous = finalizedDatabase[folderId];
    finalizedDatabase[folderId] = {
        finalizedAt: typeof previous === 'object' && previous.finalizedAt
            ? previous.finalizedAt
            : new Date().toISOString()
    };
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

        const ownerId = firebaseDb ? (await firebaseDb.ref(`finderAlbumOwners/${folderId}`).once('value')).val() : null;
        const tokens = await getStoredTokensForStudio(ownerId);
        // CÂU BÁO LỖI ĐÃ ĐƯỢC THAY ĐỔI
        if (!tokens) return res.status(401).json({ error: "Server chưa nhận được Token từ Vercel." });
        
        const oauth2Client = getOAuth2Client();
        if (!oauth2Client) return res.status(500).json({ error: "Thiếu file oauth-credentials.json trên Server." });

        oauth2Client.setCredentials(tokens);
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

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
    const finalizedRecord = finalizedDatabase[folderId];
    const isFinalized = !!finalizedRecord;
    const likedFilesMap = {};
    
    Object.keys(currentAlbumLikes).forEach(key => {
        const item = currentAlbumLikes[key];
        const isLiked = typeof item === 'object' ? item.isLiked : item;
        if (isLiked) likedFilesMap[key] = typeof item === 'object' ? item.note : "";
    });
    
    res.json({
        success: true,
        folderId,
        liked_files: likedFilesMap,
        isFinalized,
        finalizedAt: typeof finalizedRecord === 'object' ? finalizedRecord.finalizedAt || null : null
    });
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
