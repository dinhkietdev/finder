const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const https = require('https'); 
const { google } = require('googleapis');
const sharp = require('sharp');
const { autoUpdater } = require('electron-updater');

// Đặt tên ở cấp ứng dụng để Dock macOS và taskbar Windows không hiển thị "Electron".
app.setName('Finder');
if (process.platform === 'win32') app.setAppUserModelId('com.finder.desktop');

// ---------------------------------------------------------
// 1. KHỞI TẠO FIREBASE BẰNG CÚ PHÁP MODULAR (CHUẨN MỚI)
// ---------------------------------------------------------
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

// Service Account chỉ dành cho server.  Bản cài cho khách không được (và cũng
// không nên) chứa khóa quản trị Firebase. Nếu có file này khi phát triển cục
// bộ thì vẫn hỗ trợ đồng bộ phụ trợ; khi đóng gói app sẽ tiếp tục hoạt động
// bình thường thông qua API server đã xác thực.
let db = null;
const serviceAccountPath = path.join(__dirname, 'firabase.json');
if (fs.existsSync(serviceAccountPath)) {
    try {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        const firebaseApp = initializeApp({
            credential: cert(serviceAccount),
            databaseURL: "https://finder-76adb-default-rtdb.asia-southeast1.firebasedatabase.app"
        });
        db = getDatabase(firebaseApp);
        console.log("✅ Firebase Admin đã khởi tạo cho môi trường phát triển.");
    } catch (error) {
        console.warn("Firebase Admin cục bộ không khả dụng:", error.message);
    }
}

// ---------------------------------------------------------
// 2. CẤU HÌNH BIẾN MÔI TRƯỜNG & ĐƯỜNG DẪN
// ---------------------------------------------------------
let mainWindow;
let oauth2Client = null;
let uploadInProgress = false;
let allowWindowClose = false;
let updateCheckStarted = false;

const ONLINE_DOMAIN = 'finder-swart-pi.vercel.app'; 
const ONLINE_SERVER = `https://${ONLINE_DOMAIN}`;
const MAX_CONCURRENT_UPLOADS = 4;
const AI_ANALYSIS_CONCURRENCY = Math.max(2, Math.min(6, (os.cpus().length || 4) - 1));
const qualityCache = new Map();
// Release marker: packaged OAuth endpoint integration and redirect fix.
// Release sync marker: build from the current local Finder baseline.
// Packaged clients reuse LOCAL_TOKEN_PATH and server refresh before OAuth.
const signatureCache = new Map();

const userDataPath = app.getPath('userData');
const historyFilePath = path.join(userDataPath, 'finderpicture-history.json');
const LOCAL_TOKEN_PATH = path.join(userDataPath, 'finderpicture-session.json');
const LOCAL_DRIVE_CLIENT_PATH = path.join(userDataPath, 'finder-drive-client.json');
const DRIVE_LOG_PATH = path.join(userDataPath, 'finder-drive.log');
const AUTH_SESSION_PATH = path.join(userDataPath, 'finder-auth-session.json');
let FIREBASE_AUTH_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
try { FIREBASE_AUTH_API_KEY = require('./firebase-auth-config').apiKey || FIREBASE_AUTH_API_KEY; } catch (error) {}
let currentAuthSession = null;
let driveAuthPromise = null;

function postJson(url, payload, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const request = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, response => {
            let body = ''; response.on('data', chunk => body += chunk);
            response.on('end', () => {
                try {
                    const result = JSON.parse(body || '{}');
                    if (response.statusCode >= 400) return reject(new Error(result.error?.message || result.error || 'Yêu cầu không thành công.'));
                    resolve(result);
                } catch (error) { reject(new Error(`Phản hồi máy chủ không hợp lệ từ ${url} (HTTP ${response.statusCode}). Nội dung: ${(body || '(rỗng)').slice(0, 180)}`)); }
            });
        });
        request.on('error', reject); request.write(data); request.end();
    });
}

function getServerJson(pathname, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: pathname, method: 'GET', headers }, response => {
            let body = ''; response.on('data', chunk => body += chunk);
            response.on('end', () => {
                try {
                    const result = JSON.parse(body || '{}');
                    if (response.statusCode >= 400) return reject(new Error(result.error || 'Không thể tải dữ liệu.'));
                    resolve(result);
                } catch (error) { reject(new Error(`Phản hồi máy chủ không hợp lệ từ ${pathname} (HTTP ${response.statusCode}). Nội dung: ${(body || '(rỗng)').slice(0, 180)}`)); }
            });
        });
        request.on('error', reject); request.end();
    });
}

function postServerJson(pathname, payload, headers = {}) {
    return postJson(`${ONLINE_SERVER}${pathname}`, payload, headers);
}

function loadAuthSession() {
    try { return fs.existsSync(AUTH_SESSION_PATH) ? JSON.parse(fs.readFileSync(AUTH_SESSION_PATH, 'utf8')) : null; }
    catch (error) { return null; }
}

function serverAuthHeaders() {
    return currentAuthSession?.idToken ? { Authorization: `Bearer ${currentAuthSession.idToken}` } : {};
}

currentAuthSession = loadAuthSession();

ipcMain.handle('auth-session', () => currentAuthSession || loadAuthSession());
ipcMain.handle('auth-sync-drive-token', async () => {
    try {
        const driveSession = await getServerJson('/api/auth/drive-token', serverAuthHeaders());
        if (driveSession.tokens) fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(driveSession.tokens), 'utf8');
        return { success: true, found: !!driveSession.tokens };
    } catch (error) { return { success: false }; }
});
ipcMain.handle('auth-drive-token-status', async () => {
    // Drive sessions belong to the current desktop machine. Do not report a
    // missing session merely because Vercel has no shared GOOGLE_SESSION_TOKEN.
    try {
        if (fs.existsSync(LOCAL_TOKEN_PATH)) {
            const tokens = JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8'));
            const usable = Boolean(tokens.refresh_token || (tokens.access_token && (!tokens.expiry_date || tokens.expiry_date > Date.now())));
            if (usable) return { success: true, found: true, source: 'local' };
        }
        const session = await getServerJson('/api/auth/drive-token', serverAuthHeaders());
        return { success: true, found: !!session.tokens, source: 'server' };
    } catch (error) { return { success: true, found: false, error: error.message }; }
});
ipcMain.handle('auth-ensure-drive-access', async () => {
    // This IPC action is invoked only by the explicit "Đăng nhập lại Google"
    // button. Automatic folder browsing/upload never reaches OAuth here.
    const check = async () => {
        const auth = await authenticateCasi(true, true);
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.list({ q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields: 'files(id)', pageSize: 1 });
    };
    try {
        await check();
        return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('auth-sign-in', async (event, { email, password, isRegister }) => {
    try {
        if (!FIREBASE_AUTH_API_KEY) throw new Error('Finder chưa được cấu hình Firebase Authentication.');
        const endpoint = isRegister ? 'signUp' : 'signInWithPassword';
        const data = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FIREBASE_AUTH_API_KEY}`, { email, password, returnSecureToken: true });
        currentAuthSession = { idToken: data.idToken, refreshToken: data.refreshToken, uid: data.localId, email: data.email };
        fs.writeFileSync(AUTH_SESSION_PATH, JSON.stringify(currentAuthSession), 'utf8');
        try {
            const driveSession = await getServerJson('/api/auth/drive-token', serverAuthHeaders());
            if (driveSession.tokens) fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(driveSession.tokens), 'utf8');
        } catch (error) {}
        return { success: true, session: currentAuthSession };
    } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('auth-sign-out', () => { currentAuthSession = null; if (fs.existsSync(AUTH_SESSION_PATH)) fs.unlinkSync(AUTH_SESSION_PATH); return true; });

function sendUpdateStatus(status, data = {}) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { status, ...data });
}

autoUpdater.autoDownload = false;
autoUpdater.on('update-available', info => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
autoUpdater.on('download-progress', progress => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', info => sendUpdateStatus('downloaded', { version: info.version }));
autoUpdater.on('error', error => sendUpdateStatus('error', { message: error.message }));

ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) return { success: true, skipped: true };
    // Bản macOS hiện được phát hành unsigned/notarized chưa đầy đủ. Việc để
    // electron-updater tự thay thế app sẽ bị Gatekeeper từ chối do chữ ký.
    // Cho Mac cập nhật thủ công bằng DMG; Windows vẫn auto-update bình thường.
    if (process.platform === 'darwin') {
        try {
            const latest = await new Promise((resolve, reject) => {
                const request = https.request({ hostname: 'api.github.com', path: '/repos/dinhkietdev/finder/releases/latest', method: 'GET', headers: { 'User-Agent': 'Finder-Desktop' } }, response => {
                    let body = ''; response.on('data', chunk => body += chunk);
                    response.on('end', () => { try { const data = JSON.parse(body); response.statusCode >= 400 ? reject(new Error(data.message || 'GitHub error')) : resolve(data); } catch (error) { reject(error); } });
                });
                request.on('error', reject); request.end();
            });
            const latestVersion = String(latest.tag_name || '').replace(/^v/, '');
            if (latestVersion && latestVersion !== app.getVersion()) sendUpdateStatus('manual-available', { version: latestVersion, url: latest.html_url || 'https://github.com/dinhkietdev/finder/releases' });
        } catch (error) { console.warn('Không thể kiểm tra bản Mac mới:', error.message); }
        return { success: true, skipped: true, manual: true };
    }
    if (updateCheckStarted) return { success: true, checking: true };
    updateCheckStarted = true;
    try { await autoUpdater.checkForUpdates(); return { success: true }; }
    catch (error) { updateCheckStarted = false; return { success: false, error: error.message }; }
});
ipcMain.handle('download-update', async () => {
    try { await autoUpdater.downloadUpdate(); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('install-update', () => { autoUpdater.quitAndInstall(); });
ipcMain.handle('open-macos-signature-fix', () => {
    if (process.platform !== 'darwin') return { success: false, error: 'Chức năng này chỉ dành cho macOS.' };
    return new Promise(resolve => {
        execFile('osascript', ['-e', 'tell application "Terminal" to do script "xattr -cr /Applications/Finder.app"'], error => resolve(error ? { success:false, error:error.message } : { success:true }));
    });
});

// ---------------------------------------------------------
// 3. LOGIC LƯU TRỮ (KẾT HỢP LOCAL & FIREBASE)
// ---------------------------------------------------------
function getAlbumHistory() {
    const filePath = getStudioHistoryFilePath();
    if (!fs.existsSync(filePath)) return [];
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } 
    catch (e) { return []; }
}

function getStudioHistoryFilePath() {
    return currentAuthSession?.uid
        ? path.join(userDataPath, `finderpicture-history-${currentAuthSession.uid}.json`)
        : historyFilePath;
}

function saveAlbumToHistory(albumData) {
    const history = getAlbumHistory();
    history.unshift(albumData);
    // Lưu vào máy tính để UI app chạy mượt mà
    fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');

    // Đẩy lên Firebase để đồng bộ với Server Vercel
    if (db && currentAuthSession?.uid) {
        db.ref(`studioAlbumHistory/${currentAuthSession.uid}/${albumData.id}`).set(albumData).catch(e => console.log(e));
    }
}

function updateAlbumStatus(folderId, newStatus) {
    const history = getAlbumHistory();
    const index = history.findIndex(a => a.id === folderId);
    if (index !== -1) {
        history[index].status = newStatus;
        fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
    }

    // Cập nhật trạng thái trên Firebase
    if (db && currentAuthSession?.uid) {
        db.ref(`studioAlbumHistory/${currentAuthSession.uid}/${folderId}`).update({ status: newStatus }).catch(e => console.log(e));
    }
}

// ---------------------------------------------------------
// 4. CÁC TÍNH NĂNG CỐT LÕI (GIỮ NGUYÊN)
// ---------------------------------------------------------
function syncDataToServer() {
    try {
        if (fs.existsSync(LOCAL_TOKEN_PATH)) {
            const tokens = JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8'));
            const postData = JSON.stringify({ tokens });
            const reqToServer = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: '/api/auth/save-token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...serverAuthHeaders() } }); 
            reqToServer.write(postData); reqToServer.end();
        }
        
        const history = getAlbumHistory();
        history.forEach(album => {
            const payload = JSON.stringify({ 
                isEnabled: album.watermarkToggle !== false, 
                text: album.watermarkText || "FINDERPICTURE STUDIO", 
                maxSelections: album.maxSelections || 0 
            });
            const req = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/${album.id}/settings`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...serverAuthHeaders() } });
            req.write(payload); req.end();
        });
    } catch(e) {}
}

ipcMain.handle('get-history', () => getAlbumHistory());
ipcMain.handle('get-last-drive-folder', () => {
    const latestAlbum = getAlbumHistory().find(album => Object.prototype.hasOwnProperty.call(album, 'driveParentId'));
    if (!latestAlbum || !latestAlbum.driveParentId) return { id: null, path: 'Drive của tôi' };

    // Album cũ chỉ có drivePath; suy ra đường dẫn thư mục cha để vẫn dùng được.
    let parentPath = latestAlbum.driveParentPath;
    if (!parentPath && latestAlbum.drivePath && latestAlbum.name) {
        const suffix = `/${latestAlbum.name}`;
        parentPath = latestAlbum.drivePath.endsWith(suffix)
            ? latestAlbum.drivePath.slice(0, -suffix.length)
            : latestAlbum.drivePath;
    }
    return { id: latestAlbum.driveParentId, path: parentPath || 'Drive của tôi' };
});
ipcMain.handle('update-status', (event, { id, status }) => { updateAlbumStatus(id, status); return true; });
ipcMain.handle('open-external-link', (event, url) => { shell.openExternal(url); });

ipcMain.handle('delete-album', async (event, folderId) => {
    let history = getAlbumHistory();
    history = history.filter(a => a.id !== folderId);
    fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
    
    // Xóa trên Firebase (nếu có)
    if (db && currentAuthSession?.uid) db.ref(`studioAlbumHistory/${currentAuthSession.uid}/${folderId}`).remove().catch(e => console.log(e));

    try {
        await new Promise((resolve) => {
            const req = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/${folderId}`, method: 'DELETE' }, (res) => { res.on('data',()=>{}); res.on('end', resolve); });
            req.on('error', resolve); req.end();
        });
    } catch (e) {}
    return { success: true };
});

ipcMain.handle('flush-all-data', async () => {
    try {
        const req = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/flush-all/data`, method: 'DELETE' }); req.end();
        return { success: true };
    } catch (e) { return { success: false }; }
});

ipcMain.handle('update-album-settings', async (event, { folderId, maxSelections }) => {
    const history = getAlbumHistory();
    const index = history.findIndex(a => a.id === folderId);
    if (index !== -1) {
        history[index].maxSelections = parseInt(maxSelections) || 0;
        fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
    }

    try {
        await new Promise((resolve) => {
            const payload = JSON.stringify({ maxSelections: parseInt(maxSelections) || 0 });
            const req = https.request({ 
                hostname: ONLINE_DOMAIN, port: 443, 
                path: `/api/album/${folderId}/settings`, 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } 
            }, (res) => { res.on('data',()=>{}); res.on('end', resolve); });
            req.on('error', resolve); req.write(payload); req.end();
        });
    } catch (e) {}
    return { success: true };
});

ipcMain.handle('get-album-thumbnail', async (event, localPath) => {
    if (!localPath || !fs.existsSync(localPath)) return null;
    try {
        const files = fs.readdirSync(localPath);
        const firstImg = files.find(f => ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(f).toLowerCase()));
        if (firstImg) {
            const fullImgPath = path.join(localPath, firstImg);
            const bitmap = fs.readFileSync(fullImgPath);
            return `data:image/${path.extname(firstImg).substring(1)};base64,${bitmap.toString('base64')}`;
        }
    } catch (e) {}
    return null;
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1150, height: 760,
        title: "Finder",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    mainWindow.loadFile('index.html');
    mainWindow.on('close', (event) => {
        if (!uploadInProgress || allowWindowClose) return;
        event.preventDefault();
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'warning',
            buttons: ['Tiếp tục tải lên', 'Vẫn đóng ứng dụng'],
            defaultId: 0,
            cancelId: 0,
            message: 'Ảnh đang được tải lên Google Drive.',
            detail: 'Đóng ứng dụng lúc này có thể làm gián đoạn quá trình tải.'
        });
        if (choice === 1) { allowWindowClose = true; mainWindow.close(); }
    });
}

app.commandLine.appendSwitch('ignore-certificate-errors');

app.whenReady().then(() => {
    createWindow();
    syncDataToServer(); 
});

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.filePaths[0];
});

ipcMain.handle('scan-images', async (event, folderPath) => {
    if (!folderPath) return [];
    const files = fs.readdirSync(folderPath);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    return files.filter(file => imageExtensions.includes(path.extname(file).toLowerCase()));
});

function getPercentile(values, percentile) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))] || 0;
}

async function inspectImageQuality(folderPath, file) {
    const input = path.join(folderPath, file);
    const fileStat = await fs.promises.stat(input);
    const cacheKey = `${input}:${fileStat.size}:${fileStat.mtimeMs}`;
    const cached = qualityCache.get(cacheKey);
    if (cached) return { ...cached, file };
    const { data, info } = await sharp(input)
        .rotate()
        // 192px vẫn đủ tin cậy cho sáng/tối và out nét, giảm đáng kể CPU/RAM.
        .resize({ width: 192, height: 192, fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let sum = 0;
    let darkPixels = 0;
    let clippedPixels = 0;
    let nearClippedPixels = 0;
    for (const value of data) {
        sum += value;
        if (value < 28) darkPixels++;
        if (value >= 250) clippedPixels++;
        if (value >= 242) nearClippedPixels++;
    }

    // Trung bình độ lớn Laplacian: ảnh càng ít chi tiết/cạnh, giá trị càng thấp.
    let laplacianTotal = 0;
    let samples = 0;
    for (let y = 1; y < info.height - 1; y++) {
        for (let x = 1; x < info.width - 1; x++) {
            const index = y * info.width + x;
            const laplacian = Math.abs(4 * data[index] - data[index - 1] - data[index + 1] - data[index - info.width] - data[index + info.width]);
            laplacianTotal += laplacian;
            samples++;
        }
    }

    const result = {
        file,
        brightness: Math.round(sum / data.length),
        darkRatio: darkPixels / data.length,
        highlightClipRatio: clippedPixels / data.length,
        nearHighlightRatio: nearClippedPixels / data.length,
        sharpness: Number((laplacianTotal / Math.max(samples, 1)).toFixed(1))
    };
    qualityCache.set(cacheKey, result);
    if (qualityCache.size > 5000) qualityCache.delete(qualityCache.keys().next().value);
    return result;
}

async function imageSignature(folderPath, file) {
    const input = path.join(folderPath, file);
    const stat = await fs.promises.stat(input);
    const key = `${input}:${stat.size}:${stat.mtimeMs}`;
    if (signatureCache.has(key)) return signatureCache.get(key);
    const { data } = await sharp(input).rotate().resize(16, 16, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
    const signature = data.map(value => value >= mean ? 1 : 0);
    signatureCache.set(key, signature);
    return signature;
}
function signatureDistance(a, b) { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++; return d / Math.max(a.length, 1); }

ipcMain.handle('analyze-image-quality', async (event, { folderPath, imageFiles }) => {
    if (!folderPath || !Array.isArray(imageFiles)) return { success: false, error: 'Thiếu thư mục hoặc danh sách ảnh.' };
    const metrics = [];
    const errors = [];
    const queue = [...imageFiles];
    let completed = 0;
    const worker = async () => {
        while (queue.length) {
            const file = queue.shift();
            try {
                metrics.push(await inspectImageQuality(folderPath, file));
                completed++;
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('culling-progress', { completed, total: imageFiles.length });
            }
            catch (error) { errors.push(file); completed++; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(AI_ANALYSIS_CONCURRENCY, queue.length) }, worker));
    const softImageThreshold = getPercentile(metrics.map(item => item.sharpness), 0.15);

    const results = metrics.map(item => {
        const issues = [];
        if (item.brightness < 58 || item.darkRatio > 0.62) issues.push('Thiếu sáng');
        // Chỉ cảnh báo khi có đủ vùng sáng bị mất chi tiết, không chỉ vì ảnh
        // có nền trắng hoặc ánh sáng mạnh. Hai ngưỡng giúp giảm cảnh báo giả.
        if (item.highlightClipRatio > 0.025 && item.brightness > 205) issues.push('Cháy sáng');
        else if ((item.highlightClipRatio > 0.008 && item.brightness > 190) ||
            (item.nearHighlightRatio > 0.16 && item.brightness > 198)) issues.push('Có nguy cơ cháy sáng');
        if (item.sharpness <= softImageThreshold && item.sharpness < 13) issues.push('Có thể out nét');
        return { ...item, issues, score: Math.max(0, 100 - issues.length * 28) };
    });
    const ordered = [...results].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
    const signatures = new Map();
    const signatureQueue = [...ordered];
    const signatureWorker = async () => {
        while (signatureQueue.length) {
            const item = signatureQueue.shift();
            try { signatures.set(item.file, await imageSignature(folderPath, item.file)); } catch (_) {}
        }
    };
    await Promise.all(Array.from({ length: Math.min(AI_ANALYSIS_CONCURRENCY, signatureQueue.length) }, signatureWorker));
    const burstGroups = []; let current = [];
    for (const item of ordered) {
        const prev = current[current.length - 1];
        if (prev && signatures.has(prev.file) && signatures.has(item.file) && signatureDistance(signatures.get(prev.file), signatures.get(item.file)) <= 0.16) current.push(item);
        else { if (current.length >= 2) burstGroups.push(current); current = [item]; }
    }
    if (current.length >= 2) burstGroups.push(current);
    burstGroups.forEach((group, index) => {
        const ranked = [...group].sort((a, b) => b.score - a.score || b.sharpness - a.sharpness);
        const selected = new Set(ranked.slice(0, Math.min(group.length, Math.max(2, Math.ceil(group.length * .4)))).map(item => item.file));
        group.forEach(item => { item.burstGroup = index + 1; item.aiRecommended = selected.has(item.file); });
    });
    return { success: true, results, skipped: errors.length };
});

ipcMain.handle('get-culling-original', async (event, { folderPath, file }) => {
    const fullPath = path.join(folderPath || '', path.basename(file || ''));
    if (!fs.existsSync(fullPath)) return { success: false, error: 'Tệp ảnh không còn tồn tại.' };
    const ext = path.extname(fullPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { success: true, dataUrl: `data:${mime};base64,${fs.readFileSync(fullPath).toString('base64')}` };
});

ipcMain.handle('get-culling-preview', async (event, { folderPath, file }) => {
    if (!folderPath || !file) return { success: false, error: 'Không tìm thấy ảnh.' };
    const fullPath = path.join(folderPath, path.basename(file));
    if (!fs.existsSync(fullPath)) return { success: false, error: 'Tệp ảnh không còn tồn tại.' };
    try {
        const preview = await sharp(fullPath)
            .rotate()
            .resize({ width: 1800, height: 1400, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88 })
            .toBuffer();
        return { success: true, dataUrl: `data:image/jpeg;base64,${preview.toString('base64')}` };
    } catch (error) {
        return { success: false, error: 'Không thể mở ảnh xem trước.' };
    }
});

function isGoogleTokenError(error) {
    return /invalid_(request|grant|client)|unauthorized_client|invalid credentials|unauthenticated|401/i.test(String(error?.message || error));
}

function friendlyDriveError(error) {
    if (String(error?.message || error) === 'DRIVE_REAUTH_REQUIRED') {
        return 'Phiên Google Drive đã hết hạn. Hãy bấm “Đăng nhập lại Google Drive” rồi thử lại.';
    }
    if (String(error?.message || error).startsWith('DRIVE_REFRESH_FAILED:')) {
        return `Không thể làm mới phiên Google Drive. Chi tiết: ${String(error.message).slice(21)}`;
    }
    if (/Unexpected end of JSON input/i.test(String(error?.message || error))) {
        return 'Google Drive trả về phản hồi rỗng hoặc không hợp lệ. Phiên Drive cần được đăng nhập lại. Mã: DRIVE_EMPTY_RESPONSE';
    }
    return error?.message || String(error);
}

function logDriveDiagnostic(stage, error) {
    try {
        const detail = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
        fs.appendFileSync(DRIVE_LOG_PATH, `[${new Date().toISOString()}] ${stage}\n${detail}\n\n`, 'utf8');
    } catch (_) {}
}

function isEmptyJsonError(error) {
    return /Unexpected end of JSON input/i.test(String(error?.message || error));
}

// Local fallback for testing: the legacy desktop OAuth flow is kept out of
// packaged builds, but lets us verify the folder picker without depending on
// the Vercel token session. The credentials file is intentionally ignored by
// git and must never be shipped.
function authenticateLegacyLocalDrive(requireFullDriveScope = false, forceReauth = false) {
    return new Promise((resolve, reject) => {
        const credentialsPath = path.join(__dirname, app.isPackaged ? 'oauth-desktop-credentials.json' : 'oauth-credentials.json');
        if (!fs.existsSync(credentialsPath)) return reject(new Error('Thiếu OAuth Desktop credentials.'));
        try {
            const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
            const { client_id, client_secret } = credentials.installed || credentials.web;
            const port = 3000;
            const redirectUri = `http://localhost:${port}/oauth2callback`;
            oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
            if (forceReauth && fs.existsSync(LOCAL_TOKEN_PATH)) {
                try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {}
            }
            if (!forceReauth && fs.existsSync(LOCAL_TOKEN_PATH)) {
                try {
                    const tokens = JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8'));
                    const scopes = (tokens.scope || '').split(' ');
                    if ((!requireFullDriveScope || scopes.includes('https://www.googleapis.com/auth/drive')) && (tokens.refresh_token || tokens.access_token)) {
                        (async () => {
                            if (tokens.refresh_token && (!tokens.expiry_date || Number(tokens.expiry_date) < Date.now() + 60000)) {
                                let refreshed;
                                try { refreshed = await postServerJson('/api/auth/drive-refresh', { refreshToken: tokens.refresh_token }, serverAuthHeaders()); }
                                catch (error) { throw new Error(`DRIVE_REFRESH_FAILED: ${error.message}`); }
                                if (!refreshed.access_token) throw new Error('DRIVE_REFRESH_FAILED: Server không trả access token mới.');
                                tokens.access_token = refreshed.access_token;
                                tokens.expiry_date = refreshed.expiry_date || Date.now() + 3600000;
                                fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(tokens), 'utf8');
                            }
                            oauth2Client.setCredentials(tokens); resolve(oauth2Client);
                        })().catch(() => reject(new Error('DRIVE_REAUTH_REQUIRED')));
                        return;
                    }
                } catch (_) {
                    // A cancelled Windows callback can leave a zero-byte JSON
                    // file. Treat it as a new machine instead of surfacing a
                    // cryptic "Unexpected end of JSON input" error.
                    try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {}
                }
            }
            shell.openExternal(oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'select_account', scope: [requireFullDriveScope ? 'https://www.googleapis.com/auth/drive' : 'https://www.googleapis.com/auth/drive.file'] }));
            const server = http.createServer(async (req, res) => {
                if (!req.url.includes('/oauth2callback')) return res.end();
                try {
                    const qs = new URL(req.url, `http://localhost:${port}`).searchParams;
                    if (!qs.get('code')) { res.statusCode = 400; res.end('Thiếu mã xác thực Google.'); server.close(); return reject(new Error('Google không trả về mã xác thực.')); }
                    const { tokens } = await oauth2Client.getToken(qs.get('code'));
                    if (requireFullDriveScope && !tokens.scope) tokens.scope = 'https://www.googleapis.com/auth/drive';
                    oauth2Client.setCredentials(tokens);
                    fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(tokens), 'utf8');
                    if (client_id) fs.writeFileSync(LOCAL_DRIVE_CLIENT_PATH, JSON.stringify({ clientId: client_id }), 'utf8');
                    res.end('Xác thực thành công. Quay lại Finder.'); server.close(); resolve(oauth2Client);
                } catch (error) { res.end('Xác thực thất bại.'); server.close(); reject(error); }
            });
            server.on('error', reject); server.listen(port);
        } catch (error) { reject(error); }
    });
}

function authenticateCasi(requireFullDriveScope = false, forceReauth = false) {
    if (fs.existsSync(path.join(__dirname, app.isPackaged ? 'oauth-desktop-credentials.json' : 'oauth-credentials.json'))) {
        return authenticateLegacyLocalDrive(requireFullDriveScope, forceReauth);
    }
    // Several UI events can arrive while the folder picker is opening. Reuse
    // one in-flight OAuth request instead of opening multiple Google tabs.
    if (driveAuthPromise && !forceReauth) return driveAuthPromise;
    driveAuthPromise = new Promise((resolve, reject) => {
        const PORT = 3000;
        const redirectUri = `http://localhost:${PORT}/oauth2callback`;
        const createClient = clientId => new google.auth.OAuth2(clientId, undefined, redirectUri);
        const useStoredToken = async () => {
            if (forceReauth || !fs.existsSync(LOCAL_TOKEN_PATH)) return false;
            let tokens;
            try { tokens = JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8')); }
            catch (_) { try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {} return false; }
            if (!tokens.refresh_token && (!tokens.access_token || !tokens.expiry_date || tokens.expiry_date < Date.now())) return false;
            let clientId = null;
            try { clientId = (await getServerJson('/api/auth/drive-client')).clientId; } catch (_) {}
            if (!clientId && fs.existsSync(LOCAL_DRIVE_CLIENT_PATH)) {
                try { clientId = JSON.parse(fs.readFileSync(LOCAL_DRIVE_CLIENT_PATH, 'utf8')).clientId; } catch (_) {}
            }
            if (!clientId) return false;
            if (tokens.refresh_token && (!tokens.expiry_date || tokens.expiry_date < Date.now() + 60000)) {
                try {
                    const refreshed = await postServerJson('/api/auth/drive-refresh', { refreshToken: tokens.refresh_token }, serverAuthHeaders());
                    if (refreshed.access_token) {
                        tokens.access_token = refreshed.access_token;
                        tokens.expiry_date = refreshed.expiry_date || Date.now() + 3600000;
                        fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(tokens), 'utf8');
                    }
                } catch (_) { return false; }
            }
            oauth2Client = createClient(clientId); oauth2Client.setCredentials(tokens); return true;
        };
        const connect = async () => {
            const authorization = await postServerJson('/api/auth/drive-authorize', { requireFullDriveScope }, serverAuthHeaders());
            if (!authorization.clientId) throw new Error('Máy chủ chưa cấu hình Google Drive OAuth.');
            oauth2Client = createClient(authorization.clientId);
            shell.openExternal(authorization.authUrl);
            const server = http.createServer(async (req, res) => {
                try {
                    if (!req.url.includes('/oauth2callback')) return res.end();
                    const qs = new URL(req.url, `http://localhost:${PORT}`).searchParams;
                    const code = qs.get('code');
                    const state = qs.get('state');
                    const result = await postServerJson('/api/auth/drive-exchange', { code, state }, serverAuthHeaders());
                    res.end('Xac thuc thanh cong! Vui long quay lai ung dung Finder.');
                    server.close();
                    oauth2Client.setCredentials(result.tokens);
                    fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(result.tokens), 'utf8');
                    if (result.clientId) fs.writeFileSync(LOCAL_DRIVE_CLIENT_PATH, JSON.stringify({ clientId: result.clientId }), 'utf8');
                    resolve(oauth2Client);
                } catch (error) { server.close(); reject(error); }
            });
            server.on('error', error => reject(new Error(`Không thể mở cổng xác thực Google (cổng ${PORT}): ${error.message}`)));
            server.listen(PORT);
        };
        useStoredToken().then(reused => {
            if (reused) return resolve(oauth2Client);
            // A token file means this is an existing machine. Do not open a
            // browser automatically when its refresh fails; require the user
            // to press the explicit reconnect button instead.
            if (fs.existsSync(LOCAL_TOKEN_PATH) && !forceReauth) throw new Error('DRIVE_REAUTH_REQUIRED');
            return getServerJson('/api/auth/drive-token', serverAuthHeaders());
        }).then(session => {
            if (!forceReauth && session.tokens && session.clientId) {
                const grantedScopes = (session.tokens.scope || '').split(' ');
                if (!requireFullDriveScope || grantedScopes.includes('https://www.googleapis.com/auth/drive')) {
                    oauth2Client = createClient(session.clientId);
                    oauth2Client.setCredentials(session.tokens);
                    fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(session.tokens), 'utf8');
                    if (session.clientId) fs.writeFileSync(LOCAL_DRIVE_CLIENT_PATH, JSON.stringify({ clientId: session.clientId }), 'utf8');
                    return resolve(oauth2Client);
                }
            }
            connect().catch(reject);
        }).catch(error => {
            if (error?.message === 'DRIVE_REAUTH_REQUIRED') return reject(error);
            connect().catch(reject);
        });
    }).finally(() => { driveAuthPromise = null; });
    return driveAuthPromise;
}

ipcMain.handle('list-drive-folders', async (event, parentId) => {
    try {
        // Quyền drive đầy đủ chỉ được yêu cầu khi người dùng mở trình chọn thư mục.
        const parent = parentId || 'root';
        const loadFolders = async forceReauth => {
            const auth = await authenticateCasi(true, forceReauth);
            const drive = google.drive({ version: 'v3', auth });
            return drive.files.list({
                q: `mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents and trashed = false`,
                fields: 'files(id, name)', orderBy: 'name_natural', pageSize: 1000,
                supportsAllDrives: true, includeItemsFromAllDrives: true
            });
        };
        const response = await loadFolders(false);
        return { success: true, folders: response.data.files || [] };
    } catch (error) {
        logDriveDiagnostic('list-drive-folders', error);
        if (isEmptyJsonError(error)) {
            try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {}
            return { success: false, error: 'Google Drive trả về phản hồi rỗng. Phiên đăng nhập cần được cấp lại (DRIVE_EMPTY_RESPONSE). Hãy mở log: ' + DRIVE_LOG_PATH };
        }
        return { success: false, error: friendlyDriveError(error) };
    }
});

ipcMain.handle('upload-to-drive', async (event, payload) => {
    let { folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, driveParentId, driveParentPath, resumeData } = payload;
    let resumableUpload = resumeData || null;
    try {
        if (resumeData) ({ folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, driveParentId, driveParentPath } = resumeData);
        uploadInProgress = true;
        mainWindow.webContents.send('upload-progress', { progress: 0, currentFile: "Đang kiểm tra bảo mật..." });
        // Uploading into a user-selected folder requires the full Drive scope.
        // Older sessions may only have drive.file, which can authenticate
        // successfully but fail when creating files under an existing folder.
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth: auth });

        let folderNameOnDrive;
        let googleDriveFolderId;
        if (resumeData) {
            folderNameOnDrive = resumeData.folderNameOnDrive;
            googleDriveFolderId = resumeData.googleDriveFolderId;
        } else {
            mainWindow.webContents.send('upload-progress', { progress: 2, currentFile: "Đang khởi tạo Album..." });
            folderNameOnDrive = customFolderName ? customFolderName : ('FinderPicture_Album_' + Date.now());
            const folderResource = { name: folderNameOnDrive, mimeType: 'application/vnd.google-apps.folder' };
            if (driveParentId) folderResource.parents = [driveParentId];
            const driveFolder = await drive.files.create({ resource: folderResource, fields: 'id' });
            googleDriveFolderId = driveFolder.data.id;
            // Lưu refresh token riêng cho album để trang khách có thể tự làm
            // mới access token sau nhiều ngày mà không cần đăng nhập lại.
            try {
                if (fs.existsSync(LOCAL_TOKEN_PATH)) {
                    const tokens = JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8'));
                    await postServerJson(`/api/album/${googleDriveFolderId}/drive-token`, { tokens });
                }
            } catch (error) { console.warn('Không thể lưu token theo album:', error.message); }
        }
        resumableUpload = { folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, driveParentId, driveParentPath, folderNameOnDrive, googleDriveFolderId };

        const existingFiles = await drive.files.list({
            q: `'${googleDriveFolderId}' in parents and trashed = false`,
            fields: 'files(name)', pageSize: 1000
        });
        const uploadedNames = new Set((existingFiles.data.files || []).map(file => file.name));

        // Google Drive nhận nhiều file song song nhanh hơn đáng kể. Giới hạn 4
        // luồng để không làm cạn băng thông hoặc bị API giới hạn yêu cầu.
        const filesToUpload = imageFiles.filter(fileName => !uploadedNames.has(fileName));
        let nextFileIndex = 0;
        let completedFiles = imageFiles.length - filesToUpload.length;
        let uploadError = null;

        async function uploadWorker() {
            while (!uploadError) {
                const index = nextFileIndex++;
                if (index >= filesToUpload.length) return;

                const fileName = filesToUpload[index];
                try {
                    await drive.files.create({
                        resource: { name: fileName, parents: [googleDriveFolderId] },
                        media: { mimeType: 'image/jpeg', body: fs.createReadStream(path.join(folderPath, fileName)) },
                        fields: 'id'
                    });
                    completedFiles++;
                    mainWindow.webContents.send('upload-progress', {
                        progress: Math.round((completedFiles / imageFiles.length) * 100),
                        currentFile: `${fileName} (${completedFiles}/${imageFiles.length})`
                    });
                } catch (error) {
                    uploadError = error;
                }
            }
        }

        const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, filesToUpload.length);
        await Promise.all(Array.from({ length: workerCount }, uploadWorker));
        if (uploadError) throw uploadError;

        await drive.permissions.create({ fileId: googleDriveFolderId, requestBody: { role: 'reader', type: 'anyone' } });
        
        const wmPayload = JSON.stringify({ isEnabled: watermarkToggle, text: watermarkText, maxSelections: maxSelections });
        const wmOptions = { hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/${googleDriveFolderId}/settings`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wmPayload), ...serverAuthHeaders() } };
        await new Promise((resolve) => {
            const wmReq = https.request(wmOptions, (res) => { res.on('data',()=>{}); res.on('end', resolve); });
            wmReq.on('error', resolve); wmReq.write(wmPayload); wmReq.end();
        });

        const publicLink = `https://${ONLINE_DOMAIN}/client.html?id=${googleDriveFolderId}`;
        
        // HÀM NÀY BÂY GIỜ SẼ LƯU VÀO CẢ MÁY TÍNH VÀ FIREBASE
        saveAlbumToHistory({ 
            id: googleDriveFolderId, 
            name: folderNameOnDrive, 
            date: new Date().toLocaleString('vi-VN'), 
            link: publicLink, 
            status: "Đang chờ khách chọn", 
            localPath: folderPath, 
            driveParentId: driveParentId || null,
            driveParentPath: driveParentPath || 'Drive của tôi',
            drivePath: `${driveParentPath || 'Drive của tôi'}/${folderNameOnDrive}`,
            maxSelections: parseInt(maxSelections) || 0, 
            watermarkToggle: watermarkToggle,
            watermarkText: watermarkText
        });

        return { success: true, folderLink: publicLink };
    } catch (error) {
        logDriveDiagnostic('upload-to-drive', error);
        if (isEmptyJsonError(error)) {
            try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {}
            return { success: false, error: 'Google Drive trả về phản hồi rỗng khi upload. Phiên đăng nhập cần được cấp lại (DRIVE_EMPTY_RESPONSE). Hãy mở log: ' + DRIVE_LOG_PATH, resumeData: resumableUpload };
        }
        return { success: false, error: friendlyDriveError(error), resumeData: resumableUpload };
    }
    finally { uploadInProgress = false; }
});

ipcMain.handle('auto-sync-raw', async (event, { folderId, likedList }) => {
    if (!likedList || Object.keys(likedList).length === 0) return { success: false, msg: "Khách chưa chọn ảnh nào." };
    const history = getAlbumHistory();
    const album = history.find(a => a.id === folderId);
    if (!album || !album.localPath || !fs.existsSync(album.localPath)) return { success: false, msg: "Không tìm thấy đường dẫn gốc. Vui lòng dùng Tab Backup thủ công!" };

    const localJpgPath = album.localPath;
    const parentPath = path.dirname(localJpgPath);
    const possibleDirs = [ localJpgPath, path.join(localJpgPath, 'RAW'), path.join(localJpgPath, 'Goc'), path.join(localJpgPath, 'File Goc'), parentPath, path.join(parentPath, 'RAW'), path.join(parentPath, 'Goc'), path.join(parentPath, 'File Goc'), path.join(parentPath, 'Capture') ];
    const cleanAlbumName = album.name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
    const targetFolder = path.join(localJpgPath, `RAW_Khach_Chon_${cleanAlbumName}`);
    if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder);

    const rawExtensions = ['.cr3', '.cr2', '.arw', '.nef', '.dng', '.raf', '.orf', '.rw2'];
    const supportedExtensions = new Set([...rawExtensions, '.jpg', '.jpeg']);
    let allAvailableFiles = [];
    let scannedDirs = new Set();
    function scanDirectory(dir, recursive = true) {
        if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || scannedDirs.has(dir) || dir === targetFolder) return;
        scannedDirs.add(dir);
        try {
            fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) return recursive ? scanDirectory(fullPath, true) : undefined;
                if (!entry.isFile()) return;
                const originalExt = path.extname(entry.name);
                const ext = originalExt.toLowerCase();
                if (supportedExtensions.has(ext)) {
                    allAvailableFiles.push({ name: entry.name, dir, ext, baseName: path.basename(entry.name, originalExt) });
                }
            });
        } catch (e) {}
    }
    // Không quét đệ quy toàn bộ thư mục cha vì có thể là cả ổ ảnh rất lớn.
    possibleDirs.forEach(dir => scanDirectory(dir, dir !== parentPath));

    const likedFileNames = Object.keys(likedList);
    let filesToCopy = [];
    let txtContent = `==================================================\n📝 DANH SÁCH ẢNH KHÁCH CHỌN & YÊU CẦU CHỈNH SỬA\nAlbum: ${album.name}\n==================================================\n\n`;

    likedFileNames.forEach((likedName, index) => {
        // Web lưu đúng tên file (ví dụ IMG_0001.jpg), còn RAW không có phần mở rộng đó.
        const likedBaseName = path.basename(likedName, path.extname(likedName));
        let matchedFiles = allAvailableFiles.filter(f => f.baseName.toLowerCase() === likedBaseName.toLowerCase());
        if (matchedFiles.length > 0) {
            matchedFiles.sort((a, b) => {
                const isRawA = rawExtensions.includes(a.ext), isRawB = rawExtensions.includes(b.ext);
                if (isRawA && !isRawB) return -1; if (!isRawA && isRawB) return 1;
                if (a.ext === '.cr3' && b.ext !== '.cr3') return -1; if (b.ext === '.cr3' && a.ext !== '.cr3') return 1;
                return 0;
            });
            const bestMatch = matchedFiles[0];
            const note = likedList[likedName] || "Chỉnh sửa cơ bản";
            filesToCopy.push({ src: path.join(bestMatch.dir, bestMatch.name), dest: path.join(targetFolder, bestMatch.name), name: bestMatch.name });
            txtContent += `${index + 1}. 📸 File: ${bestMatch.name}\n   🛠️ Yêu cầu: ${note}\n----------------------------------\n`;
        }
    });

    if (filesToCopy.length === 0) return { success: false, msg: "Không tìm thấy file tương ứng trong ổ cứng." };

    let copiedCount = 0;
    for (let i = 0; i < filesToCopy.length; i++) {
        const fileObj = filesToCopy[i];
        if (fileObj.src !== fileObj.dest && !fs.existsSync(fileObj.dest)) await fs.promises.copyFile(fileObj.src, fileObj.dest);
        copiedCount++;
        mainWindow.webContents.send('sync-progress', { progress: Math.round((copiedCount / filesToCopy.length) * 100), currentFile: fileObj.name, count: `${copiedCount}/${filesToCopy.length}` });
    }
    fs.writeFileSync(path.join(targetFolder, 'Yêu_Cầu_Chỉnh_Sửa.txt'), txtContent, 'utf8');
    shell.openPath(targetFolder);
    return { success: true, msg: `Đã bốc thành công ${copiedCount} file RAW!` };
});

ipcMain.handle('sync-liked-images-manual', async (event, { sourceFolder, likedList }) => {
    const targetFolder = path.join(sourceFolder, 'RAW_Khach_Chon');
    if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder);
    const likedBaseNames = new Set(Object.keys(likedList).map(fileName =>
        path.basename(fileName, path.extname(fileName)).toLowerCase()
    ));
    const rawExtensions = new Set(['.cr3', '.cr2', '.arw', '.nef', '.dng', '.raf', '.orf', '.rw2']);
    
    let filesToCopy = [];
    function findRawFiles(dir) {
        if (dir === targetFolder) return;
        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) return findRawFiles(fullPath);
            const originalExt = path.extname(entry.name);
            const ext = originalExt.toLowerCase();
            const baseName = path.basename(entry.name, originalExt).toLowerCase();
            if (entry.isFile() && rawExtensions.has(ext) && likedBaseNames.has(baseName)) {
                filesToCopy.push({ src: fullPath, dest: path.join(targetFolder, entry.name), name: entry.name });
            }
        });
    }
    try { findRawFiles(sourceFolder); } catch (error) { return { success: false, msg: `Không thể quét thư mục RAW: ${error.message}` }; }
    if (!filesToCopy.length) return { success: false, msg: 'Không tìm thấy RAW có tên tương ứng với ảnh khách đã chọn.' };

    let copiedCount = 0;
    for (let i = 0; i < filesToCopy.length; i++) {
        const fileObj = filesToCopy[i];
        if (fileObj.src !== fileObj.dest && !fs.existsSync(fileObj.dest)) await fs.promises.copyFile(fileObj.src, fileObj.dest);
        copiedCount++;
        mainWindow.webContents.send('sync-progress-manual', { progress: Math.round((copiedCount / filesToCopy.length) * 100), currentFile: fileObj.name });
    }
    shell.openPath(targetFolder);
    return { success: true, msg: `Đã gom thủ công ${copiedCount} file RAW!` };
});
