const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
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
    likedImagesDatabase = state.likedImagesDatabase || {};
    albumSettingsDatabase = state.albumSettingsDatabase || {};
    bannedAlbums = state.bannedAlbums || [];
    finalizedDatabase = state.finalizedDatabase || {};
}

async function persistState() {
    saveDB();
    if (firebaseDb) {
        await firebaseDb.ref('finderPictureState').set({ likedImagesDatabase, albumSettingsDatabase, bannedAlbums, finalizedDatabase });
    }
}

function getOAuth2Client() {
    // 1. Ưu tiên đọc từ biến môi trường trên Vercel (Bảo mật cao nhất)
    if (process.env.GOOGLE_OAUTH_CREDENTIALS) {
        try {
            const credentials = JSON.parse(process.env.GOOGLE_OAUTH_CREDENTIALS);
            const { client_id, client_secret } = credentials.installed || credentials.web;
            return new google.auth.OAuth2(client_id, client_secret);
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
    return new google.auth.OAuth2(client_id, client_secret);
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

        const tokens = getStoredTokens();
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

        const files = (response.data.files || []).map(file => {
            const nameWithoutExt = path.basename(file.name, path.extname(file.name));
            let thumb = file.thumbnailLink || file.webContentLink || '';
            if (thumb.includes('=s220')) thumb = thumb.replace('=s220', '=s800');
            else if (file.thumbnailLink) thumb += '=s800';
            return { id: file.id, fullName: file.name, shortName: nameWithoutExt, thumbnail: thumb, originalUrl: file.webContentLink };
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
    const isFinalized = !!finalizedDatabase[folderId];
    const likedFilesMap = {};
    
    Object.keys(currentAlbumLikes).forEach(key => {
        const item = currentAlbumLikes[key];
        const isLiked = typeof item === 'object' ? item.isLiked : item;
        if (isLiked) likedFilesMap[key] = typeof item === 'object' ? item.note : "";
    });
    
    res.json({ success: true, folderId, liked_files: likedFilesMap, isFinalized });
});

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server FinderPicture chạy tại cổng ${PORT}`));
}

module.exports = app;
