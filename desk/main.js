const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
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

const userDataPath = app.getPath('userData');
const historyFilePath = path.join(userDataPath, 'finderpicture-history.json');
const LOCAL_TOKEN_PATH = path.join(userDataPath, 'finderpicture-session.json');
const AUTH_SESSION_PATH = path.join(userDataPath, 'finder-auth-session.json');
let FIREBASE_AUTH_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
try { FIREBASE_AUTH_API_KEY = require('./firebase-auth-config').apiKey || FIREBASE_AUTH_API_KEY; } catch (error) {}
let currentAuthSession = null;

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
                } catch (error) { reject(new Error('Phản hồi máy chủ không hợp lệ.')); }
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
                } catch (error) { reject(new Error('Phản hồi máy chủ không hợp lệ.')); }
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
    const { data, info } = await sharp(input)
        .rotate()
        .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let sum = 0;
    let darkPixels = 0;
    let brightPixels = 0;
    for (const value of data) {
        sum += value;
        if (value < 28) darkPixels++;
        if (value > 235) brightPixels++;
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

    return {
        file,
        brightness: Math.round(sum / data.length),
        darkRatio: darkPixels / data.length,
        brightRatio: brightPixels / data.length,
        sharpness: Number((laplacianTotal / Math.max(samples, 1)).toFixed(1))
    };
}

ipcMain.handle('analyze-image-quality', async (event, { folderPath, imageFiles }) => {
    if (!folderPath || !Array.isArray(imageFiles)) return { success: false, error: 'Thiếu thư mục hoặc danh sách ảnh.' };
    const metrics = [];
    const errors = [];
    const queue = [...imageFiles];
    const worker = async () => {
        while (queue.length) {
            const file = queue.shift();
            try { metrics.push(await inspectImageQuality(folderPath, file)); }
            catch (error) { errors.push(file); }
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    const softImageThreshold = getPercentile(metrics.map(item => item.sharpness), 0.15);

    const results = metrics.map(item => {
        const issues = [];
        if (item.brightness < 58 || item.darkRatio > 0.62) issues.push('Thiếu sáng');
        if (item.brightness > 202 || item.brightRatio > 0.32) issues.push('Có nguy cơ cháy sáng');
        if (item.sharpness <= softImageThreshold && item.sharpness < 13) issues.push('Có thể out nét');
        return { ...item, issues, score: Math.max(0, 100 - issues.length * 28) };
    });
    return { success: true, results, skipped: errors.length };
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
    return /invalid_(request|grant|client)|unauthorized_client/i.test(String(error?.message || error));
}

function authenticateCasi(requireFullDriveScope = false, forceReauth = false) {
    return new Promise((resolve, reject) => {
        const PORT = 3000;
        const redirectUri = `http://localhost:${PORT}/oauth2callback`;
        const createClient = clientId => new google.auth.OAuth2(clientId, undefined, redirectUri);
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
                    resolve(oauth2Client);
                } catch (error) { server.close(); reject(error); }
            }).listen(PORT);
        };
        getServerJson('/api/auth/drive-token', serverAuthHeaders()).then(session => {
            if (!forceReauth && session.tokens && session.clientId) {
                const grantedScopes = (session.tokens.scope || '').split(' ');
                if (!requireFullDriveScope || grantedScopes.includes('https://www.googleapis.com/auth/drive')) {
                    oauth2Client = createClient(session.clientId);
                    oauth2Client.setCredentials(session.tokens);
                    fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify(session.tokens), 'utf8');
                    return resolve(oauth2Client);
                }
            }
            connect().catch(reject);
        }).catch(() => connect().catch(reject));
    });
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
        let response;
        try { response = await loadFolders(false); }
        catch (error) {
            if (!isGoogleTokenError(error)) throw error;
            response = await loadFolders(true);
        }
        return { success: true, folders: response.data.files || [] };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('upload-to-drive', async (event, payload) => {
    let { folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, driveParentId, driveParentPath, resumeData } = payload;
    let resumableUpload = resumeData || null;
    try {
        if (resumeData) ({ folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, driveParentId, driveParentPath } = resumeData);
        uploadInProgress = true;
        mainWindow.webContents.send('upload-progress', { progress: 0, currentFile: "Đang kiểm tra bảo mật..." });
        const auth = await authenticateCasi();
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
    } catch (error) { return { success: false, error: error.message, resumeData: resumableUpload }; }
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
