const { app, BrowserWindow, Menu, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const https = require('https'); 
const { google } = require('googleapis');
const sharp = require('sharp');
const { autoUpdater } = require('electron-updater');
const { cleanupCullingPreviewCache, createCullingPreview } = require('./culling-preview');
const { resolveImagePath, getUploadFingerprint, selectFilesToUpload } = require('./upload-fingerprint');

// Đặt tên ở cấp ứng dụng để Dock macOS và taskbar Windows không hiển thị "Electron".
const DESKTOP_PROTOCOL = 'finder-v2';
let pendingProtocolUrl = null;
function handleProtocolUrl(value) {
    if (typeof value !== 'string' || !value.startsWith(`${DESKTOP_PROTOCOL}://`)) return;
    pendingProtocolUrl = value;
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        const protocolUrl = commandLine.find(value => value.startsWith(`${DESKTOP_PROTOCOL}://`));
        handleProtocolUrl(protocolUrl);
    });
    if (process.platform === 'darwin') {
        app.on('open-url', (event, url) => { event.preventDefault(); handleProtocolUrl(url); });
    }
}
app.setName('DK Workflow');
if (process.platform === 'win32') app.setAppUserModelId('com.finder.desktop');

// Keep the desktop data directory stable across branding changes. Electron
// derives `userData` from app.name, so changing Finder -> DK Workflow would
// otherwise make every existing local album appear to disappear after an
// update. The canonical directory remains Finder for backwards compatibility.
const defaultUserDataPath = app.getPath('userData');
const stableUserDataPath = path.join(app.getPath('appData'), 'Finder');
try {
    fs.mkdirSync(stableUserDataPath, { recursive: true });
    app.setPath('userData', stableUserDataPath);
} catch (error) {
    // Keep the app usable if a platform refuses to change the path. The
    // migration below still imports history from the legacy directories.
    console.warn('Không thể cố định thư mục dữ liệu Finder:', error.message);
}

// The default Electron menu exposes File/Edit/View/... and makes the app look
// like an unfinished development build.  The dashboard owns all actions, so
// remove the native menu on every platform while keeping keyboard shortcuts
// and the renderer UI intact.
Menu.setApplicationMenu(null);

// ---------------------------------------------------------
// 1. CẤU HÌNH BIẾN MÔI TRƯỜNG & ĐƯỜNG DẪN
// ---------------------------------------------------------
let mainWindow;
let oauth2Client = null;
let uploadInProgress = false;
let allowWindowClose = false;
let updateCheckStarted = false;

const ONLINE_DOMAIN = 'finder-swart-pi.vercel.app'; 
const ONLINE_SERVER = `https://${ONLINE_DOMAIN}`;
// Google Drive cho phép nhiều request upload song song. Giới hạn 6 luồng để
// tận dụng băng thông nhưng vẫn tránh làm nghẽn máy hoặc bị quota 429.
const MAX_CONCURRENT_UPLOADS = Math.max(2, Math.min(8, Number(process.env.FINDER_UPLOAD_CONCURRENCY) || 6));
const AI_ANALYSIS_CONCURRENCY = Math.max(2, Math.min(6, (os.cpus().length || 4) - 1));
const qualityCache = new Map();
// Release marker: packaged OAuth endpoint integration and redirect fix.
// Release sync marker: build from the current local Finder baseline.
// Packaged clients reuse LOCAL_TOKEN_PATH and server refresh before OAuth.
const signatureCache = new Map();

function isRetryableDriveUploadError(error) {
    const status = Number(error?.code || error?.response?.status || error?.status) || 0;
    return status === 408 || status === 429 || status >= 500 || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(`${error?.code || ''} ${error?.message || ''}`);
}

function uploadTiming(completed, total, startedAt) {
    const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
    const rate = completed > 0 ? Math.round(completed / elapsedSeconds * 60) : 0;
    const etaSeconds = completed > 0 && total > completed ? Math.max(0, Math.round((total - completed) / (completed / elapsedSeconds))) : 0;
    return { rate, etaSeconds };
}

async function uploadDriveFileWithRetry(drive, { fileName, parentId, localPath, mimeType, fingerprint }) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await drive.files.create({
                resource: {
                    name: fileName,
                    parents: [parentId],
                    ...(fingerprint?.md5Checksum ? { appProperties: { finderMd5: fingerprint.md5Checksum, finderSize: fingerprint.size } } : {})
                },
                media: { mimeType, body: fs.createReadStream(localPath) },
                fields: 'id'
            });
        } catch (error) {
            lastError = error;
            if (!isRetryableDriveUploadError(error) || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        }
    }
    throw lastError;
}

function slugifyAlbumName(value = '') {
    return String(value)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56) || 'album';
}

const userDataPath = app.getPath('userData');
const historyFilePath = path.join(userDataPath, 'finderpicture-history.json');
const legacyHistoryDirectories = [...new Set([
    defaultUserDataPath,
    path.join(app.getPath('appData'), 'Finder'),
    path.join(app.getPath('appData'), 'DK Workflow'),
    path.join(app.getPath('appData'), 'finderpicture-studio'),
    path.join(app.getPath('appData'), 'finder')
])].filter(directory => directory !== userDataPath);
const LOCAL_TOKEN_PATH = path.join(userDataPath, 'finderpicture-session.json');
const LOCAL_TOKEN_ENCRYPTED_PATH = path.join(userDataPath, 'finderpicture-session.enc');
const LOCAL_DRIVE_CLIENT_PATH = path.join(userDataPath, 'finder-drive-client.json');
const DRIVE_LOG_PATH = path.join(userDataPath, 'finder-drive.log');
const PENDING_UPLOAD_PATH = path.join(userDataPath, 'finder-pending-upload.json');
const UPLOAD_QUEUE_PATH = path.join(userDataPath, 'finder-upload-queue.json');
const BACKUP_DIR = path.join(userDataPath, 'backups');
const QUALITY_CACHE_PATH = path.join(userDataPath, 'finder-quality-cache.json');
// Culling preview files are kept outside the renderer/IPC payload. Returning
// a file URL avoids converting every preview buffer into a large Base64 string.
const CULLING_PREVIEW_DIR = path.join(userDataPath, 'culling-previews');
let qualityCachePersistTimer = null;
try {
    if (fs.existsSync(QUALITY_CACHE_PATH)) {
        const saved = JSON.parse(fs.readFileSync(QUALITY_CACHE_PATH, 'utf8'));
        Object.entries(saved).forEach(([key, value]) => qualityCache.set(key, value));
    }
} catch (_) {}
function scheduleQualityCachePersist() {
    clearTimeout(qualityCachePersistTimer);
    qualityCachePersistTimer = setTimeout(() => {
        try {
            const entries = [...qualityCache.entries()].slice(-5000);
            fs.writeFileSync(QUALITY_CACHE_PATH, JSON.stringify(Object.fromEntries(entries)), 'utf8');
        } catch (_) {}
    }, 800);
}

const AUTH_SESSION_PATH = path.join(userDataPath, 'finder-auth-session.json');
let FIREBASE_AUTH_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
try { FIREBASE_AUTH_API_KEY = require('./firebase-auth-config').apiKey || FIREBASE_AUTH_API_KEY; } catch (error) {}
let currentAuthSession = null;
let driveAuthPromise = null;
let historyMigrationCompleted = false;

function canUseSecureStorage() {
    try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); }
    catch (_) { return false; }
}

function readLocalDriveTokens() {
    if (canUseSecureStorage() && fs.existsSync(LOCAL_TOKEN_ENCRYPTED_PATH)) {
        const raw = safeStorage.decryptString(fs.readFileSync(LOCAL_TOKEN_ENCRYPTED_PATH));
        return JSON.parse(raw);
    }
    // Migrate a token file created by older Finder releases on first use.
    if (fs.existsSync(LOCAL_TOKEN_PATH)) {
        const tokens = JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8'));
        if (canUseSecureStorage()) {
            writeLocalDriveTokens(tokens);
            try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {}
        }
        return tokens;
    }
    return null;
}

function writeLocalDriveTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') throw new Error('Token Google Drive không hợp lệ.');
    if (canUseSecureStorage()) {
        const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
        const temporary = `${LOCAL_TOKEN_ENCRYPTED_PATH}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
        fs.renameSync(temporary, LOCAL_TOKEN_ENCRYPTED_PATH);
        try { fs.unlinkSync(LOCAL_TOKEN_PATH); } catch (_) {}
        return;
    }
    // Older/unsupported systems still get restrictive file permissions rather
    // than an openly readable token file. The server-side copy is encrypted.
    const temporary = `${LOCAL_TOKEN_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(tokens), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, LOCAL_TOKEN_PATH);
}

function hasLocalDriveTokens() {
    return fs.existsSync(LOCAL_TOKEN_ENCRYPTED_PATH) || fs.existsSync(LOCAL_TOKEN_PATH);
}

function removeLocalDriveTokens() {
    // Remove stale credentials from the canonical directory and the legacy
    // app-data directories. Without clearing the legacy copies, the startup
    // migration can import the same revoked token again after a restart.
    const tokenPaths = [LOCAL_TOKEN_ENCRYPTED_PATH, LOCAL_TOKEN_PATH, LOCAL_DRIVE_CLIENT_PATH];
    for (const directory of legacyHistoryDirectories) {
        tokenPaths.push(
            path.join(directory, 'finderpicture-session.enc'),
            path.join(directory, 'finderpicture-session.json'),
            path.join(directory, 'finder-drive-client.json')
        );
    }
    for (const tokenPath of new Set(tokenPaths)) {
        try { fs.unlinkSync(tokenPath); } catch (_) {}
    }
}

function readUploadQueue() {
    try {
        if (fs.existsSync(UPLOAD_QUEUE_PATH)) {
            const saved = JSON.parse(fs.readFileSync(UPLOAD_QUEUE_PATH, 'utf8'));
            if (saved && Array.isArray(saved.jobs)) return { version: 1, jobs: saved.jobs.filter(job => job && job.id && job.resumeData) };
        }
    } catch (_) {}
    // Migrate the single pending-upload file written by older releases.
    try {
        if (fs.existsSync(PENDING_UPLOAD_PATH)) {
            const resumeData = JSON.parse(fs.readFileSync(PENDING_UPLOAD_PATH, 'utf8'));
            if (resumeData && typeof resumeData === 'object') {
                const migrated = { version: 1, jobs: [{ id: crypto.randomUUID(), type: 'original', status: 'paused', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resumeData }] };
                writeUploadQueue(migrated);
                return migrated;
            }
        }
    } catch (_) {}
    return { version: 1, jobs: [] };
}

function writeUploadQueue(queue) {
    const safeQueue = { version: 1, jobs: Array.isArray(queue?.jobs) ? queue.jobs.slice(-20) : [] };
    const temporary = `${UPLOAD_QUEUE_PATH}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(safeQueue), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, UPLOAD_QUEUE_PATH);
        try { fs.unlinkSync(PENDING_UPLOAD_PATH); } catch (_) {}
    } catch (_) {
        try { fs.unlinkSync(temporary); } catch (_) {}
    }
}

function upsertUploadJob(job) {
    const queue = readUploadQueue();
    const index = queue.jobs.findIndex(item => item.id === job.id);
    if (index === -1) queue.jobs.push(job); else queue.jobs[index] = { ...queue.jobs[index], ...job, updatedAt: new Date().toISOString() };
    writeUploadQueue(queue);
}

function removeUploadJob(jobId) {
    if (!jobId) return;
    const queue = readUploadQueue();
    queue.jobs = queue.jobs.filter(job => job.id !== jobId);
    writeUploadQueue(queue);
}

function pendingUploadResumeData() {
    const queue = readUploadQueue();
    const job = queue.jobs.find(item => ['pending', 'paused', 'running'].includes(item.status) && (!item.type || item.type === 'original'));
    if (!job?.resumeData) return null;
    return { ...job.resumeData, _queueJobId: job.id, _queueStatus: job.status, _queueCompletedFiles: job.completedFiles || 0, _queueFailedFiles: job.failedFiles || [] };
}

function postJson(url, payload, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const request = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, response => {
            let body = ''; response.on('data', chunk => body += chunk);
            response.on('end', () => {
                try {
                    const result = JSON.parse(body || '{}');
                    if (response.statusCode >= 400) {
                        const requestId = response.headers['x-request-id'] || result.requestId;
                        return reject(new Error(`${result.error?.message || result.error || 'Yêu cầu không thành công.'}${requestId ? ` [requestId=${requestId}]` : ''}`));
                    }
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
                    if (response.statusCode >= 400) {
                        const requestId = response.headers['x-request-id'] || result.requestId;
                        return reject(new Error(`${result.error || 'Không thể tải dữ liệu.'}${requestId ? ` [requestId=${requestId}]` : ''}`));
                    }
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

function albumManagementHeaders(folderId) {
    const album = getAlbumHistory().find(item => String(item.id) === String(folderId));
    return album?.managementToken ? { 'x-finder-management-token': album.managementToken } : {};
}

function syncHistoryToServer(albumData) {
    if (!albumData?.id) return;
    const { managementToken, ...history } = albumData;
    postServerJson(`/api/album/${encodeURIComponent(albumData.id)}/manager-history`, { history }, {
        ...serverAuthHeaders(),
        ...driveAccessHeaders(),
        ...albumManagementHeaders(albumData.id)
    }).catch(error => console.warn('Không thể đồng bộ lịch sử album lên Supabase:', error.message));
}

function loadAuthSession() {
    try { return fs.existsSync(AUTH_SESSION_PATH) ? JSON.parse(fs.readFileSync(AUTH_SESSION_PATH, 'utf8')) : null; }
    catch (error) { return null; }
}

function serverAuthHeaders() {
    return currentAuthSession?.idToken ? { Authorization: `Bearer ${currentAuthSession.idToken}` } : {};
}

// Creation endpoints use the already-authorized, short-lived Drive access
// token as proof that this desktop controls the selected Drive account. It is
// sent only in a request header and is never persisted by the server.
function driveAccessHeaders(auth = oauth2Client) {
    const accessToken = auth?.credentials?.access_token;
    return accessToken ? { 'x-finder-drive-access-token': accessToken } : {};
}

// Return a current short-lived Drive access token without opening an OAuth
// window. The Google client can refresh an existing credential in-process;
// only a missing/revoked session should be handled by the explicit reconnect
// button in the UI.
async function refreshDriveAccessForManagement() {
    if (oauth2Client) {
        try {
            const result = await oauth2Client.getAccessToken();
            if (result?.token) {
                oauth2Client.setCredentials({ ...oauth2Client.credentials, access_token: result.token, expiry_date: Date.now() + 3500000 });
                return result.token;
            }
        } catch (_) {}
    }
    if (hasLocalDriveTokens()) {
        try {
            const auth = await authenticateCasi(true);
            return auth?.credentials?.access_token || '';
        } catch (_) {}
    }
    return oauth2Client?.credentials?.access_token || '';
}

async function revokePublicDrivePermissions(drive, fileId) {
    if (!drive || !fileId) return;
    try {
        const result = await drive.permissions.list({ fileId, fields: 'permissions(id,type,role)', supportsAllDrives: true });
        for (const permission of result.data.permissions || []) {
            if (permission.type === 'anyone' && permission.id) {
                try { await drive.permissions.delete({ fileId, permissionId: permission.id, supportsAllDrives: true }); }
                catch (error) { console.warn('Không thể gỡ quyền Drive công khai:', error.message); }
            }
        }
    } catch (error) { console.warn('Không thể kiểm tra quyền Drive công khai:', error.message); }
}

// Import history and credentials before loading the session so a branding
// update cannot leave the app looking like a fresh installation.
migrateLegacyHistoryFiles();
currentAuthSession = loadAuthSession();

ipcMain.handle('auth-session', () => currentAuthSession || loadAuthSession());
ipcMain.handle('auth-sync-drive-token', async () => {
    try {
        const driveSession = await getServerJson('/api/auth/drive-token', serverAuthHeaders());
        if (driveSession.tokens) writeLocalDriveTokens(driveSession.tokens);
        return { success: true, found: !!driveSession.tokens };
    } catch (error) { return { success: false }; }
});
ipcMain.handle('auth-drive-token-status', async () => {
    // Drive sessions belong to the current desktop machine. Do not report a
    // missing session merely because Vercel has no shared GOOGLE_SESSION_TOKEN.
    try {
        if (hasLocalDriveTokens()) {
            const tokens = readLocalDriveTokens();
            const usable = Boolean(tokens.refresh_token || (tokens.access_token && (!tokens.expiry_date || tokens.expiry_date > Date.now())));
            if (usable) return { success: true, found: true, source: 'local' };
        }
        const session = await getServerJson('/api/auth/drive-token', serverAuthHeaders());
        return { success: true, found: !!session.tokens, source: 'server' };
    } catch (error) { return { success: true, found: false, error: error.message }; }
});
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('get-pending-upload', () => {
    return pendingUploadResumeData();
});
ipcMain.handle('get-upload-queue', () => {
    const queue = readUploadQueue();
    return queue.jobs.filter(job => ['pending', 'paused', 'running'].includes(job.status)).map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        completedFiles: job.completedFiles || 0,
        failedFiles: job.failedFiles || [],
        error: job.error || '',
        resumeData: job.resumeData || null
    }));
});
ipcMain.handle('drive-account', async () => {
    try {
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth });
        const result = await drive.about.get({ fields: 'user(displayName,emailAddress,photoLink)' });
        return { success: true, user: result.data.user || {} };
    } catch (error) {
        logDriveDiagnostic('drive-account', error);
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('drive-account-stale', error);
        return { success: false, error: friendlyDriveError(error) };
    }
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
            if (driveSession.tokens) writeLocalDriveTokens(driveSession.tokens);
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
function readHistoryRecords(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object');
        if (Array.isArray(parsed?.albums)) return parsed.albums.filter(item => item && typeof item === 'object');
    } catch (error) {
        console.warn('Không thể đọc lịch sử album:', filePath, error.message);
    }
    return [];
}

function historyRecordKey(album, index) {
    const key = album?.id || album?.folderId || album?.publicSlug;
    return key ? String(key) : `legacy-record-${index}`;
}

function historyRecordTime(album) {
    const values = [album?.updatedAt, album?.statusUpdatedAt, album?.createdAt, album?.date];
    for (const value of values) {
        const time = Date.parse(String(value || ''));
        if (Number.isFinite(time)) return time;
    }
    return 0;
}

function mergeHistoryRecords(sources) {
    const merged = new Map();
    let anonymousIndex = 0;
    for (const source of sources) {
        for (const album of source) {
            const key = historyRecordKey(album, anonymousIndex++);
            const previous = merged.get(key);
            if (!previous) {
                merged.set(key, { ...album });
                continue;
            }
            const previousTime = historyRecordTime(previous);
            const incomingTime = historyRecordTime(album);
            const newer = incomingTime >= previousTime ? album : previous;
            const older = newer === album ? previous : album;
            // Preserve fields older builds did not know about (for example
            // localPath and Drive metadata), while newer state wins.
            merged.set(key, { ...older, ...newer });
        }
    }
    return [...merged.values()].sort((a, b) => historyRecordTime(b) - historyRecordTime(a));
}

function findHistoryFiles(directory) {
    try {
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
        return fs.readdirSync(directory)
            .filter(file => /^finderpicture-history(?:-[^/]+)?\.json$/i.test(file))
            .map(file => path.join(directory, file));
    } catch (_) { return []; }
}

function migrateLegacySupportFiles() {
    const fileNames = [
        'finderpicture-session.enc',
        'finderpicture-session.json',
        'finder-drive-client.json',
        'finder-auth-session.json',
        'finder-upload-queue.json',
        'finder-pending-upload.json',
        'finder-quality-cache.json',
        'finder-drive.log'
    ];
    try { fs.mkdirSync(userDataPath, { recursive: true }); } catch (_) { return; }
    for (const directory of legacyHistoryDirectories) {
        for (const fileName of fileNames) {
            const source = path.join(directory, fileName);
            const target = path.join(userDataPath, fileName);
            try {
                if (!fs.existsSync(target) && fs.existsSync(source) && fs.statSync(source).isFile()) {
                    fs.copyFileSync(source, target);
                    console.info(`Đã khôi phục dữ liệu Finder cũ: ${fileName}`);
                }
            } catch (error) {
                console.warn(`Không thể khôi phục ${fileName}:`, error.message);
            }
        }
    }
}

function migrateLegacyHistoryFiles() {
    if (historyMigrationCompleted) return;
    historyMigrationCompleted = true;
    migrateLegacySupportFiles();
    const files = [
        ...findHistoryFiles(userDataPath),
        ...legacyHistoryDirectories.flatMap(findHistoryFiles)
    ];
    const uniqueFiles = [...new Set(files)];
    const sources = uniqueFiles.map(readHistoryRecords).filter(records => records.length > 0);
    if (!sources.length) return;

    const merged = mergeHistoryRecords(sources);
    try {
        fs.mkdirSync(userDataPath, { recursive: true });
        fs.writeFileSync(historyFilePath, JSON.stringify(merged, null, 2), 'utf8');
        const importedFiles = uniqueFiles.filter(filePath => filePath !== historyFilePath && readHistoryRecords(filePath).length > 0);
        if (importedFiles.length) console.info(`Đã hợp nhất ${merged.length} album từ dữ liệu Finder cũ.`);
    } catch (error) {
        historyMigrationCompleted = false;
        console.warn('Không thể lưu lịch sử album đã hợp nhất:', error.message);
    }
}

function getAlbumHistory() {
    migrateLegacyHistoryFiles();
    const filePath = getStudioHistoryFilePath();
    if (!fs.existsSync(filePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.albums) ? parsed.albums : []);
    }
    catch (e) { return []; }
}

function getStudioHistoryFilePath() {
    // Keep one canonical history for this desktop installation. Previously
    // this path changed with Firebase UID, so sign-out/session expiry made
    // existing albums disappear from the library.
    return historyFilePath;
}

function createHistoryBackup(reason = 'manual') {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(BACKUP_DIR, `albums-${reason}-${stamp}.json`);
        fs.writeFileSync(target, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), albums: getAlbumHistory() }, null, 2), 'utf8');
        const files = fs.readdirSync(BACKUP_DIR).filter(file => file.endsWith('.json')).sort();
        files.slice(0, Math.max(0, files.length - 20)).forEach(file => { try { fs.unlinkSync(path.join(BACKUP_DIR, file)); } catch (_) {} });
        return target;
    } catch (_) { return null; }
}

function saveAlbumToHistory(albumData) {
    const initialStatus = albumData.status || 'Đang chờ khách chọn';
    albumData.statusHistory = albumData.statusHistory || [{ status: initialStatus, at: new Date().toISOString(), source: 'create' }];
    const history = getAlbumHistory();
    const existingIndex = history.findIndex(item => String(item.id || '') === String(albumData.id || ''));
    if (existingIndex >= 0) {
        history[existingIndex] = { ...history[existingIndex], ...albumData };
        history.unshift(history.splice(existingIndex, 1)[0]);
    } else {
        history.unshift(albumData);
    }
    // Lưu vào máy tính để UI app chạy mượt mà
    fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');

    // Đồng bộ lịch sử lên Server/Supabase; Firebase không còn là kho lịch sử.
    syncHistoryToServer(albumData);
}

function updateAlbumStatus(folderId, newStatus) {
    const history = getAlbumHistory();
    const index = history.findIndex(a => a.id === folderId);
    if (index !== -1) {
        const previous = history[index].status || 'Đang chờ khách chọn';
        if (previous !== newStatus) {
            createHistoryBackup('before-status-change');
            history[index].statusHistory = Array.isArray(history[index].statusHistory) ? history[index].statusHistory : [{ status: previous, at: new Date().toISOString(), source: 'legacy' }];
            history[index].statusHistory.push({ status: newStatus, at: new Date().toISOString(), source: 'manual' });
            history[index].statusHistory = history[index].statusHistory.slice(-30);
        }
        history[index].status = newStatus;
        fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
    }

    const updated = history.find(item => item.id === folderId);
    if (updated) syncHistoryToServer(updated);
}

// ---------------------------------------------------------
// 4. CÁC TÍNH NĂNG CỐT LÕI (GIỮ NGUYÊN)
// ---------------------------------------------------------
function syncDataToServer() {
    try {
        const history = getAlbumHistory();
        history.forEach(album => {
            const payloadData = {
                isEnabled: album.watermarkToggle !== false, 
                text: album.watermarkText || "FINDERPICTURE STUDIO", 
                publicSlug: album.publicSlug,
                clientName: album.clientName || album.name,
                originalFolderId: album.originalFolderId || null,
                galleryType: album.galleryType || 'selection',
                partyGallery: album.galleryType === 'party',
                gallerySections: Array.isArray(album.gallerySections) ? album.gallerySections : [],
                expiresDays: Number(album.expiresDays) || 60,
                expiresAt: album.expiresAt || null,
                studioLogo: album.studioLogo || '',
                accentColor: album.accentColor || '#7c8cff'
            };
            // Do not turn an unknown/legacy local value into an instruction to
            // erase a limit that is already stored on the server. Explicit
            // limit edits use update-album-settings and still send zero when
            // the user intentionally chooses “unlimited”.
            if (album.maxSelections !== undefined && album.maxSelections !== null && String(album.maxSelections).trim() !== '' && Number(album.maxSelections) > 0) {
                payloadData.maxSelections = Number(album.maxSelections);
            }
            // Only sync a custom brand. The API preserves an existing custom
            // brand when a legacy Desktop record has no brand configured.
            const configuredStudio = String(album.studioName || '').trim();
            if (configuredStudio && !/^(finder|finder studio)$/i.test(configuredStudio)) {
                payloadData.studioName = configuredStudio.toUpperCase();
            }
            const payload = JSON.stringify(payloadData);
            const req = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/${album.id}/settings`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Finder-Background-Sync': '1', ...serverAuthHeaders(), ...albumManagementHeaders(album.id) } });
            req.write(payload); req.end();
        });
    } catch(e) {}
}

ipcMain.handle('get-history', () => getAlbumHistory());
ipcMain.handle('backup-album-config', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Sao lưu cấu hình album', defaultPath: path.join(app.getPath('documents'), `finder-albums-${new Date().toISOString().slice(0,10)}.json`), filters: [{ name: 'Finder backup', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
        fs.writeFileSync(result.filePath, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), albums: getAlbumHistory() }, null, 2), 'utf8');
        return { success: true, path: result.filePath };
    } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('restore-album-config', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Khôi phục cấu hình album', properties: ['openFile'], filters: [{ name: 'Finder backup', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    try {
        const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
        if (!data || !Array.isArray(data.albums)) throw new Error('File backup không đúng định dạng Finder.');
        createHistoryBackup('before-restore');
        fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(data.albums, null, 2), 'utf8');
        return { success: true, count: data.albums.length };
    } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('export-drive-log', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Xuất log Finder', defaultPath: path.join(app.getPath('documents'), 'finder-drive.log'), filters: [{ name: 'Log file', extensions: ['log', 'txt'] }] });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
        fs.copyFileSync(DRIVE_LOG_PATH, result.filePath);
        return { success: true, path: result.filePath };
    } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('open-drive-log', async () => { try { if (!fs.existsSync(DRIVE_LOG_PATH)) fs.writeFileSync(DRIVE_LOG_PATH, 'Finder Drive log\n', 'utf8'); await shell.openPath(DRIVE_LOG_PATH); return { success: true, path: DRIVE_LOG_PATH }; } catch (error) { return { success: false, error: error.message }; } });
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
ipcMain.handle('update-payment-status', (event, { id, paymentStatus, paymentTotal, paymentDeposit, paymentPaid, paymentPayer, paymentNote }) => {
    const history = getAlbumHistory(); const index = history.findIndex(item => item.id === id);
    if (index === -1) return { success: false, error: 'Không tìm thấy album.' };
    const total = Math.max(0, Number(paymentTotal) || 0);
    const deposit = Math.max(0, Number(paymentDeposit) || 0);
    const paid = Math.max(0, Number(paymentPaid) || 0);
    const received = deposit + paid;
    history[index].paymentTotal = total;
    history[index].paymentDeposit = deposit;
    history[index].paymentPaid = paid;
    history[index].paymentBalance = Math.max(0, total - received);
    history[index].paymentPayer = ['client', 'studio', 'personal'].includes(paymentPayer) ? paymentPayer : 'client';
    history[index].paymentNote = String(paymentNote || '').trim();
    history[index].paymentStatus = received <= 0 ? 'unpaid' : (total > 0 && received >= total ? 'paid' : 'deposit');
    history[index].paymentUpdatedAt = new Date().toISOString();
    fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
    syncHistoryToServer(history[index]);
    postServerJson(`/api/album/${id}/settings`, { paymentStatus: history[index].paymentStatus, paymentAmount: total, paymentTotal: total, paymentDeposit: deposit, paymentPaid: paid, paymentBalance: history[index].paymentBalance, paymentPayer: history[index].paymentPayer, paymentNote: history[index].paymentNote }, { ...serverAuthHeaders(), ...albumManagementHeaders(id) }).catch(() => {});
    return { success: true, paymentStatus: history[index].paymentStatus, paymentBalance: history[index].paymentBalance };
});
ipcMain.handle('open-external-link', (event, url) => { shell.openExternal(url); });

ipcMain.handle('delete-album', async (event, folderId) => {
    createHistoryBackup('before-delete');
    let history = getAlbumHistory();
    history = history.filter(a => a.id !== folderId);
    fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
    
    try {
        await new Promise((resolve) => {
            const req = https.request({ hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/${folderId}`, method: 'DELETE', headers: albumManagementHeaders(folderId) }, (res) => { res.on('data',()=>{}); res.on('end', resolve); });
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
    const nextLimit = parseInt(maxSelections) || 0;
    let syncResult = null;

    try {
        // Refresh an existing local Drive session before sending the request.
        // This makes the legacy-token bootstrap reliable even when the access
        // token expired while Finder was closed, without forcing a new OAuth
        // window when the machine has no Drive session at all.
        // Never leave the settings modal blocked by a stalled OAuth refresh.
        // If refresh is slow, continue with the current credential and let
        // the server return a precise authentication error instead.
        await Promise.race([
            refreshDriveAccessForManagement(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Làm mới phiên Google Drive quá thời gian.')), 8000))
        ]).catch(error => logDriveDiagnostic('update-album-settings-drive-refresh', error));
        syncResult = await new Promise((resolve) => {
            const payload = JSON.stringify({ maxSelections: nextLimit, reopenSelection: true });
            const req = https.request({ 
                hostname: ONLINE_DOMAIN, port: 443, 
                path: `/api/album/${folderId}/settings`, 
                method: 'POST', 
                // Legacy albums may not have a management token in the local
                // history. The connected Drive access token is the one-time
                // owner proof accepted by the server to bootstrap that token.
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...serverAuthHeaders(),
                    ...driveAccessHeaders(oauth2Client),
                    ...albumManagementHeaders(folderId)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    let parsed = {};
                    try { parsed = JSON.parse(body || '{}'); } catch (_) {
                        parsed = { error: `Máy chủ trả về dữ liệu không hợp lệ (HTTP ${res.statusCode}).` };
                    }
                    if (res.statusCode >= 400) {
                        const requestId = res.headers['x-request-id'] || parsed.requestId;
                        const detail = parsed.error?.message || parsed.error || `Máy chủ từ chối yêu cầu (HTTP ${res.statusCode}).`;
                        return resolve({ success: false, error: `${detail}${requestId ? ` [requestId=${requestId}]` : ''}`, code: parsed.code, statusCode: res.statusCode, requestId });
                    }
                    resolve({ success: parsed.success !== false, ...parsed });
                });
            });
            req.setTimeout(20000, () => req.destroy(new Error('Máy chủ không phản hồi sau 20 giây.')));
            req.on('error', error => resolve({ success: false, error: error.message || 'Không thể kết nối máy chủ.' }));
            req.write(payload); req.end();
        });
        if (!syncResult?.success) {
            logDriveDiagnostic('update-album-settings', syncResult?.error || syncResult);
            return {
                success: false,
                error: syncResult?.error || 'Server không lưu được giới hạn mới. Hãy kiểm tra kết nối Google Drive rồi thử lại.',
                code: syncResult?.code,
                statusCode: syncResult?.statusCode,
                requestId: syncResult?.requestId
            };
        }
    } catch (e) { return { success: false, error: e.message }; }

    if (index !== -1) {
        createHistoryBackup('before-settings-change');
        history[index].maxSelections = nextLimit;
        // A legacy album can receive its management token when the Drive
        // proof is accepted by the server. Persist it locally so subsequent
        // edits use the stable per-album token instead of re-bootstrap.
        if (syncResult.managementToken) history[index].managementToken = syncResult.managementToken;
        history[index].rawSynced = false;
        delete history[index].rawSyncedAt;
        // Đổi giới hạn đồng nghĩa mở lại luồng chọn ảnh. Giữ nguyên các ảnh
        // khách đã chọn nhưng đưa album về trạng thái chờ để họ có thể bổ sung.
        history[index].status = 'Đang chờ khách chọn';
        history[index].statusHistory = Array.isArray(history[index].statusHistory) ? history[index].statusHistory : [];
        if (history[index].statusHistory.at(-1)?.status !== history[index].status) history[index].statusHistory.push({ status: history[index].status, at: new Date().toISOString(), source: 'limit-change' });
        history[index].statusHistory = history[index].statusHistory.slice(-30);
        fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
        syncHistoryToServer(history[index]);
    }
    return { success: true };
});

ipcMain.handle('get-album-thumbnail', async (event, localPath) => {
    if (!localPath || !fs.existsSync(localPath)) return null;
    try {
        const files = fs.readdirSync(localPath);
        const firstImg = files.find(f => ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(f).toLowerCase()));
        if (firstImg) {
            // Chỉ dùng thumbnail nhỏ cho thư viện desktop. Trả về file URL
            // trong cache thay vì Base64 để IPC/renderer không giữ một chuỗi
            // lớn trong RAM cho mỗi album.
            const thumbUri = await createCullingPreview({
                cacheDir: CULLING_PREVIEW_DIR,
                folderPath: localPath,
                file: firstImg,
                width: 480,
                height: 320,
                quality: 78,
                resolveImagePath
            });
            cleanupCullingPreviewCache();
            return thumbUri;
        }
    } catch (e) {}
    return null;
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1150, height: 760,
        title: "DK Workflow",
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
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

app.whenReady().then(() => {
    try {
        const args = process.defaultApp && process.argv[1] ? [path.resolve(process.argv[1])] : [];
        app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, ...args);
        const startupUrl = process.argv.find(value => value.startsWith(`${DESKTOP_PROTOCOL}://`));
        handleProtocolUrl(startupUrl);
    } catch (_) {}
    cleanupCullingPreviewCache();
    createWindow();
    syncDataToServer(); 
});

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.filePaths[0];
});

ipcMain.handle('scan-images', async (event, folderPath) => {
    if (!folderPath) return [];
    const files = await fs.promises.readdir(folderPath);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    const images = [];
    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (imageExtensions.includes(path.extname(file).toLowerCase())) images.push(file);
        if (index === files.length - 1 || index % 50 === 0) {
            mainWindow.webContents.send('scan-progress', { scanned: index + 1, total: files.length, found: images.length });
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    return images;
});

function getPercentile(values, percentile) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))] || 0;
}

async function inspectImageQuality(folderPath, file) {
    const input = resolveImagePath(folderPath, file);
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
    scheduleQualityCachePersist();
    return result;
}

async function imageSignature(folderPath, file) {
    const input = resolveImagePath(folderPath, file);
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

ipcMain.handle('analyze-image-quality', async (event, { folderPath, imageFiles, strictness = 'balanced' }) => {
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
    const strictFactor = strictness === 'strict' ? 1.18 : strictness === 'relaxed' ? 0.82 : 1;
    const maxSharpness = Math.max(metrics.reduce((max, item) => Math.max(max, item.sharpness), 0), softImageThreshold * 2, 1);

    const results = metrics.map(item => {
        const issues = [];
        if (item.brightness < 58 * strictFactor || item.darkRatio > 0.62 * (strictness === 'strict' ? .9 : 1.08)) issues.push('Thiếu sáng');
        // Chỉ cảnh báo khi có đủ vùng sáng bị mất chi tiết, không chỉ vì ảnh
        // có nền trắng hoặc ánh sáng mạnh. Hai ngưỡng giúp giảm cảnh báo giả.
        if (item.highlightClipRatio > 0.025 / strictFactor && item.brightness > 205) issues.push('Cháy sáng');
        else if ((item.highlightClipRatio > 0.008 / strictFactor && item.brightness > 190) ||
            (item.nearHighlightRatio > 0.16 / strictFactor && item.brightness > 198)) issues.push('Có nguy cơ cháy sáng');
        if (item.sharpness <= softImageThreshold * strictFactor && item.sharpness < 13 * strictFactor) issues.push('Có thể out nét');
        const sharpnessScore = Math.max(0, Math.min(100, Math.round((item.sharpness / maxSharpness) * 100)));
        const exposureScore = Math.max(0, Math.min(100, Math.round(100 - Math.abs(item.brightness - 128) * .72 - item.darkRatio * 18 - item.highlightClipRatio * 90)));
        const score = Math.max(0, Math.min(100, Math.round(sharpnessScore * .55 + exposureScore * .45 - issues.length * 8)));
        return { ...item, issues, score, sharpnessScore, exposureScore, expressionHint: 'Cần kiểm tra biểu cảm bằng mắt' };
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
        // Không giới hạn tổng số ảnh đề xuất; trong mỗi cụm giữ lại nhóm đầu
        // theo điểm chất lượng để người dùng có nhiều lựa chọn hơn.
        const selected = new Set(ranked.slice(0, Math.max(2, Math.ceil(group.length * .5))).map(item => item.file));
        group.forEach(item => { item.burstGroup = index + 1; item.aiRecommended = selected.has(item.file); });
    });
    return { success: true, results, skipped: errors.length };
});

ipcMain.handle('get-culling-original', async (event, { folderPath, file }) => {
    // Chỉ cần preview đủ rõ để kiểm tra. Ghi ra cache tạm rồi trả URL file,
    // tránh đưa buffer ảnh lớn qua IPC dưới dạng chuỗi Base64.
    try {
        const previewUrl = await createCullingPreview({ cacheDir: CULLING_PREVIEW_DIR, folderPath, file, width: 1600, height: 1200, quality: 82, resolveImagePath });
        cleanupCullingPreviewCache();
        return { success: true, previewUrl, preview: true };
    } catch (error) {
        return { success: false, error: error.message || 'Không thể tạo ảnh xem culling an toàn.' };
    }
});

ipcMain.handle('get-culling-preview', async (event, { folderPath, file }) => {
    if (!folderPath || !file) return { success: false, error: 'Không tìm thấy ảnh.' };
    try {
        const previewUrl = await createCullingPreview({ cacheDir: CULLING_PREVIEW_DIR, folderPath, file, width: 1280, height: 1000, quality: 78, resolveImagePath });
        cleanupCullingPreviewCache();
        return { success: true, previewUrl };
    } catch (error) {
        return { success: false, error: error.message || 'Không thể mở ảnh xem trước.' };
    }
});

function isGoogleTokenError(error) {
    return /invalid_(request|grant|client)|unauthorized_client|invalid credentials|unauthenticated|401/i.test(String(error?.message || error));
}

function isStaleDriveCredentialError(error) {
    const message = String(error?.message || error || '');
    const status = Number(error?.code || error?.response?.status || error?.status) || 0;
    return status === 401 || /unauthorized_client|invalid_grant|invalid_client|token has been expired or revoked|invalid credentials/i.test(message);
}

function clearStaleDriveSession(stage, error) {
    logDriveDiagnostic(stage, error);
    removeLocalDriveTokens();
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
            if (forceReauth && hasLocalDriveTokens()) removeLocalDriveTokens();
            if (!forceReauth && hasLocalDriveTokens()) {
                try {
                    const tokens = readLocalDriveTokens();
                    const scopes = (tokens.scope || '').split(' ');
                    if ((!requireFullDriveScope || scopes.includes('https://www.googleapis.com/auth/drive')) && (tokens.refresh_token || tokens.access_token)) {
                        (async () => {
                            if (tokens.refresh_token && (!tokens.expiry_date || Number(tokens.expiry_date) < Date.now() + 60000)) {
                                let refreshed;
                                try { refreshed = await postServerJson('/api/auth/drive-refresh', { refreshToken: tokens.refresh_token }, serverAuthHeaders()); }
                                catch (error) {
                                    if (isStaleDriveCredentialError(error)) {
                                        clearStaleDriveSession('oauth-refresh-stale-legacy', error);
                                        throw new Error('DRIVE_REAUTH_REQUIRED');
                                    }
                                    throw new Error(`DRIVE_REFRESH_FAILED: ${error.message}`);
                                }
                                if (!refreshed.access_token) throw new Error('DRIVE_REFRESH_FAILED: Server không trả access token mới.');
                                tokens.access_token = refreshed.access_token;
                                tokens.expiry_date = refreshed.expiry_date || Date.now() + 3600000;
                                writeLocalDriveTokens(tokens);
                            }
                            oauth2Client.setCredentials(tokens); resolve(oauth2Client);
                        })().catch(error => reject(error?.message === 'DRIVE_REAUTH_REQUIRED' ? error : new Error('DRIVE_REAUTH_REQUIRED')));
                        return;
                    }
                } catch (_) {
                    // A cancelled Windows callback can leave a zero-byte JSON
                    // file. Treat it as a new machine instead of surfacing a
                    // cryptic "Unexpected end of JSON input" error.
                    removeLocalDriveTokens();
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
                    writeLocalDriveTokens(tokens);
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
            if (forceReauth || !hasLocalDriveTokens()) return false;
            let tokens;
            try { tokens = readLocalDriveTokens(); }
            catch (_) { removeLocalDriveTokens(); return false; }
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
                        writeLocalDriveTokens(tokens);
                    }
                } catch (error) {
                    if (isStaleDriveCredentialError(error)) {
                        clearStaleDriveSession('oauth-refresh-stale-online', error);
                        throw new Error('DRIVE_REAUTH_REQUIRED');
                    }
                    return false;
                }
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
                    writeLocalDriveTokens(result.tokens);
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
            if (hasLocalDriveTokens() && !forceReauth) throw new Error('DRIVE_REAUTH_REQUIRED');
            return getServerJson('/api/auth/drive-token', serverAuthHeaders());
        }).then(session => {
            if (!forceReauth && session.tokens && session.clientId) {
                const grantedScopes = (session.tokens.scope || '').split(' ');
                if (!requireFullDriveScope || grantedScopes.includes('https://www.googleapis.com/auth/drive')) {
                    oauth2Client = createClient(session.clientId);
                    oauth2Client.setCredentials(session.tokens);
                    writeLocalDriveTokens(session.tokens);
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
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('list-drive-folders-stale', error);
        if (isEmptyJsonError(error)) {
            removeLocalDriveTokens();
            return { success: false, error: 'Google Drive trả về phản hồi rỗng. Phiên đăng nhập cần được cấp lại (DRIVE_EMPTY_RESPONSE). Hãy mở log: ' + DRIVE_LOG_PATH };
        }
        return { success: false, error: friendlyDriveError(error) };
    }
});

ipcMain.handle('create-drive-folder', async (event, payload = {}) => {
    const parentId = payload.parentId || 'root';
    const name = String(payload.name || '').trim();
    if (!name) return { success: false, error: 'Tên thư mục không được để trống.' };
    try {
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth });
        const result = await drive.files.create({
            resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id,name', supportsAllDrives: true
        });
        return { success: true, folder: result.data };
    } catch (error) {
        logDriveDiagnostic('create-drive-folder', error);
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('create-drive-folder-stale', error);
        return { success: false, error: friendlyDriveError(error) };
    }
});

// Upload gallery tiệc/PSC: không chạy AI culling. Mỗi gallery có một thư mục
// khách hàng riêng bên dưới thư mục đích, rồi mỗi ngày/đợt ảnh là một thư mục
// con (Vu quy, Thành hôn...). Nhờ vậy các lần bổ sung vẫn dùng cùng một link.
ipcMain.handle('upload-party-gallery', async (event, payload = {}) => {
    const resumeData = payload.resumeData || null;
    const uploadJobId = resumeData?._queueJobId || crypto.randomUUID();
    const folderPath = resumeData?.folderPath || payload.folderPath;
    const imageFiles = (Array.isArray(resumeData?.imageFiles || payload.imageFiles) ? (resumeData?.imageFiles || payload.imageFiles) : []).filter(file => /\.jpe?g$|\.png$|\.webp$/i.test(file));
    const driveParentId = resumeData?.driveParentId || payload.driveParentId || 'root';
    const folderName = String(resumeData?.folderName || payload.folderName || payload.galleryName || 'Ảnh tiệc').trim() || 'Ảnh tiệc';
    const galleryName = String(resumeData?.galleryName || payload.galleryName || folderName).trim() || folderName;
    const sectionName = String(resumeData?.sectionName ?? payload.sectionName ?? '').trim();
    const studioName = String(resumeData?.studioName || payload.studioName || 'Finder').trim().toUpperCase() || 'FINDER';
    const expiresDays = Math.min(3650, Math.max(1, Number(resumeData?.expiresDays || payload.expiresDays) || 60));
    const galleryId = resumeData?.galleryId || `party-${crypto.randomUUID()}`;
    if (!folderPath || !fs.existsSync(folderPath)) return { success: false, error: 'Không tìm thấy thư mục ảnh tiệc.' };
    if (!imageFiles.length) return { success: false, error: 'Thư mục không có ảnh JPG/PNG/WebP hợp lệ.' };
    let customerFolderId = resumeData?.customerFolderId || null;
    let sectionFolderId = resumeData?.sectionFolderId || null;
    try {
        uploadInProgress = true;
        mainWindow.webContents.send('upload-progress', { progress: 0, currentFile: 'Đang kết nối Google Drive…', completed: 0, total: imageFiles.length, failed: 0 });
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth });
        await drive.about.get({ fields: 'user(emailAddress)' });
        if (!customerFolderId) {
            const customerFolder = await drive.files.create({
                resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [driveParentId] },
                fields: 'id,name', supportsAllDrives: true
            });
            customerFolderId = customerFolder.data.id;
        }
        if (!customerFolderId) throw new Error('Không thể tạo thư mục khách hàng trên Google Drive.');
        sectionFolderId = resumeData?.sectionFolderId || customerFolderId;
        if (sectionName && !resumeData?.sectionFolderId) {
            const sectionFolder = await drive.files.create({
                resource: { name: sectionName, mimeType: 'application/vnd.google-apps.folder', parents: [customerFolderId] },
                fields: 'id,name', supportsAllDrives: true
            });
            sectionFolderId = sectionFolder.data.id;
            if (!sectionFolderId) throw new Error('Không thể tạo thư mục ngày/đợt ảnh trên Google Drive.');
        }
        const resumableParty = { folderPath, imageFiles, driveParentId, folderName, galleryName, sectionName, studioName, expiresDays, customerFolderId, sectionFolderId, galleryId, _queueJobId: uploadJobId };
        upsertUploadJob({ id: uploadJobId, type: 'party', status: 'running', createdAt: new Date().toISOString(), completedFiles: 0, failedFiles: [], resumeData: resumableParty });
        const existingFiles = await drive.files.list({ q: `'${sectionFolderId}' in parents and trashed = false`, fields: 'files(name,size,md5Checksum,appProperties)', pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true });
        const { filesToUpload, fingerprints } = await selectFilesToUpload(imageFiles, existingFiles.data.files || [], folderPath);
        let completed = imageFiles.length - filesToUpload.length;
        let failed = 0; let nextIndex = 0; let uploadError = null;
        const startedAt = Date.now();
        const worker = async () => {
            while (!uploadError) {
                const index = nextIndex++;
                if (index >= filesToUpload.length) return;
                const fileName = filesToUpload[index];
                try {
                    const ext = path.extname(fileName).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                    const fingerprint = fingerprints.get(fileName) || await getUploadFingerprint(resolveImagePath(folderPath, fileName));
                    await uploadDriveFileWithRetry(drive, { fileName: path.basename(fileName), parentId: sectionFolderId, localPath: resolveImagePath(folderPath, fileName), mimeType, fingerprint });
                    completed++;
                    upsertUploadJob({ id: uploadJobId, type: 'party', status: 'running', completedFiles: completed, failedFiles: failed, resumeData: resumableParty });
                    const timing = uploadTiming(completed, imageFiles.length, startedAt);
                    mainWindow.webContents.send('upload-progress', { progress: Math.round(completed / imageFiles.length * 100), currentFile: `${fileName} (${completed}/${imageFiles.length})`, completed, total: imageFiles.length, failed, rate: timing.rate, etaSeconds: timing.etaSeconds });
                } catch (error) { failed++; uploadError = error; const timing = uploadTiming(completed, imageFiles.length, startedAt); mainWindow.webContents.send('upload-progress', { progress: Math.round(completed / imageFiles.length * 100), currentFile: `Lỗi: ${fileName}`, completed, total: imageFiles.length, failed, rate: timing.rate, etaSeconds: timing.etaSeconds }); }
            }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, Math.max(1, filesToUpload.length)) }, worker));
        if (uploadError) throw uploadError;
        await Promise.all([customerFolderId, sectionFolderId].map(id => revokePublicDrivePermissions(drive, id)));
        const publicSlug = slugifyAlbumName(`${folderName}-${customerFolderId.slice(-6)}`);
        const metadata = await postServerJson('/api/party-gallery', { galleryId, driveFolderId: customerFolderId, sectionDriveFolderId: sectionFolderId, folderName, galleryName, sectionName, studioName, publicSlug, expiresDays }, { ...serverAuthHeaders(), ...driveAccessHeaders(auth) });
        if (hasLocalDriveTokens()) {
            try {
                const tokens = readLocalDriveTokens();
                await postServerJson(`/api/album/${galleryId}/drive-token`, { tokens, driveFolderId: customerFolderId, galleryType: 'party', gallerySections: [{ id: sectionFolderId, name: sectionName || 'Tất cả', driveFolderId: sectionFolderId }] }, { ...driveAccessHeaders(auth), ...(metadata.managementToken ? { 'x-finder-management-token': metadata.managementToken } : {}) });
            } catch (error) { console.warn('Không thể lưu token gallery tiệc:', error.message); }
        }
        const publicLink = metadata.link || `https://${ONLINE_DOMAIN}/a/${metadata.publicSlug || publicSlug}`;
        saveAlbumToHistory({ id: galleryId, name: galleryName, date: new Date().toLocaleString('vi-VN'), link: publicLink, publicSlug: metadata.publicSlug || publicSlug, clientName: folderName, driveFolderName: folderName, studioName, galleryType: 'party', managementToken: metadata.managementToken || null, originalFolderId: customerFolderId, gallerySections: [{ id: sectionFolderId, name: sectionName || 'Tất cả', driveFolderId: sectionFolderId }], status: 'Đã cập nhật · Gallery tiệc', expiresDays, expiresAt: metadata.expiresAt || null, paymentStatus: 'unpaid', paymentAmount: 0, localPath: folderPath, driveParentId: customerFolderId, driveParentPath: payload.driveParentPath || 'Drive của tôi', drivePath: `${payload.driveParentPath || 'Drive của tôi'} / ${folderName}${sectionName ? ` / ${sectionName}` : ''}` });
        mainWindow.webContents.send('upload-progress', { progress: 100, currentFile: 'Đã hoàn tất gallery tiệc.', completed: imageFiles.length, total: imageFiles.length, failed: 0 });
        removeUploadJob(uploadJobId);
        return { success: true, folderLink: publicLink, completed: imageFiles.length, failed: 0, expiresAt: metadata.expiresAt };
    } catch (error) {
        logDriveDiagnostic('upload-party-gallery', error);
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('upload-party-gallery-stale', error);
        upsertUploadJob({ id: uploadJobId, type: 'party', status: 'paused', error: friendlyDriveError(error), resumeData: { folderPath, imageFiles, driveParentId, folderName, galleryName, sectionName, studioName, expiresDays, customerFolderId, sectionFolderId, galleryId, _queueJobId: uploadJobId } });
        return { success: false, error: friendlyDriveError(error) };
    } finally { uploadInProgress = false; }
});

ipcMain.handle('append-party-gallery', async (event, payload = {}) => {
    const resumeData = payload.resumeData || null;
    const uploadJobId = resumeData?._queueJobId || crypto.randomUUID();
    const history = getAlbumHistory();
    const folderId = resumeData?.folderId || payload.folderId;
    const album = history.find(item => item.id === folderId && item.galleryType === 'party');
    const folderPath = resumeData?.folderPath || payload.folderPath;
    const imageFiles = Array.isArray(resumeData?.imageFiles || payload.imageFiles) ? (resumeData?.imageFiles || payload.imageFiles) : [];
    const sectionName = String(resumeData?.sectionName || payload.sectionName || 'Ngày mới').trim() || 'Ngày mới';
    if (!album) return { success: false, error: 'Không tìm thấy gallery tiệc.' };
    if (!folderPath || !fs.existsSync(folderPath) || !imageFiles.length) return { success: false, error: 'Thư mục bổ sung không có ảnh hợp lệ.' };
    try {
        uploadInProgress = true;
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth });
        const parentId = album.driveParentId || album.originalFolderId;
        if (!parentId) throw new Error('Gallery chưa có thư mục Drive gốc.');
        const created = resumeData?.sectionFolderId ? { data: { id: resumeData.sectionFolderId } } : await drive.files.create({ resource: { name: sectionName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id' });
        const sectionFolderId = created.data.id;
        const resumableParty = { folderId, folderPath, imageFiles, sectionName, sectionFolderId, _queueJobId: uploadJobId };
        upsertUploadJob({ id: uploadJobId, type: 'party-append', status: 'running', createdAt: new Date().toISOString(), completedFiles: 0, failedFiles: [], resumeData: resumableParty });
        const existing = await drive.files.list({ q: `'${sectionFolderId}' in parents and trashed = false`, fields: 'files(name,size,md5Checksum,appProperties)', pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true });
        const { filesToUpload, fingerprints } = await selectFilesToUpload(imageFiles, existing.data.files || [], folderPath);
        let completed = imageFiles.length - filesToUpload.length; let failed = 0; let nextIndex = 0; let uploadError = null;
        const startedAt = Date.now();
        const worker = async () => {
            while (!uploadError) {
                const index = nextIndex++;
                if (index >= filesToUpload.length) return;
                const fileName = filesToUpload[index];
                try {
                    const ext = path.extname(fileName).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                    const fingerprint = fingerprints.get(fileName) || await getUploadFingerprint(resolveImagePath(folderPath, fileName));
                    await uploadDriveFileWithRetry(drive, { fileName: path.basename(fileName), parentId: sectionFolderId, localPath: resolveImagePath(folderPath, fileName), mimeType, fingerprint });
                    completed++;
                    upsertUploadJob({ id: uploadJobId, type: 'party-append', status: 'running', completedFiles: completed, failedFiles: failed, resumeData: resumableParty });
                    const timing = uploadTiming(completed, imageFiles.length, startedAt);
                    mainWindow.webContents.send('upload-progress', { progress: Math.round(completed / imageFiles.length * 100), currentFile: `${sectionName}/${fileName}`, completed, total: imageFiles.length, failed, rate: timing.rate, etaSeconds: timing.etaSeconds });
                } catch (error) { failed++; uploadError = error; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, imageFiles.length) }, worker));
        if (uploadError) throw uploadError;
        await revokePublicDrivePermissions(drive, sectionFolderId);
        const response = await postServerJson(`/api/party-gallery/${album.id}/sections`, { driveFolderId: sectionFolderId, sectionName }, { ...serverAuthHeaders(), ...driveAccessHeaders(auth), ...albumManagementHeaders(album.id) });
        const index = history.findIndex(item => item.id === album.id);
        const sections = Array.isArray(history[index].gallerySections) ? history[index].gallerySections : [];
        sections.push({ id: sectionFolderId, name: sectionName, driveFolderId: sectionFolderId, createdAt: new Date().toISOString() });
        if (index >= 0) { history[index].gallerySections = sections; history[index].status = 'Đã cập nhật · Gallery tiệc'; history[index].statusUpdatedAt = new Date().toISOString(); history[index].drivePath = `${history[index].driveParentPath || 'Drive của tôi'} / ${history[index].driveFolderName || history[index].clientName || history[index].name || 'Ảnh tiệc'} / ${sectionName}`; fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8'); syncHistoryToServer(history[index]); }
        mainWindow.webContents.send('upload-progress', { progress: 100, currentFile: `Đã hoàn tất ${sectionName}.`, completed: imageFiles.length, total: imageFiles.length, failed: 0 });
        removeUploadJob(uploadJobId);
        return { success: true, completed, failed, folderLink: album.link, gallerySections: response.gallerySections || sections };
    } catch (error) {
        logDriveDiagnostic('append-party-gallery', error);
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('append-party-gallery-stale', error);
        upsertUploadJob({ id: uploadJobId, type: 'party-append', status: 'paused', error: friendlyDriveError(error), resumeData: { folderId, folderPath, imageFiles, sectionName, _queueJobId: uploadJobId } });
        return { success: false, error: friendlyDriveError(error) };
    }
    finally { uploadInProgress = false; }
});

ipcMain.handle('upload-to-drive', async (event, payload) => {
    let { folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, studioName, displayName, studioLogo, accentColor, dueDate, driveParentId, driveParentPath, resumeData } = payload;
    let resumableUpload = resumeData || null;
    let uploadJobId = resumeData?._queueJobId || crypto.randomUUID();
    const queueState = { completedFiles: Number(resumeData?._queueCompletedFiles || 0), failedFiles: [] };
    try {
        if (resumeData) ({ folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, studioName, displayName, studioLogo, accentColor, dueDate, driveParentId, driveParentPath } = resumeData);
        uploadInProgress = true;
        mainWindow.webContents.send('upload-progress', { progress: 0, currentFile: "Đang kiểm tra bảo mật..." });
        // Uploading into a user-selected folder requires the full Drive scope.
        // Older sessions may only have drive.file, which can authenticate
        // successfully but fail when creating files under an existing folder.
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth: auth });
        // Preflight bằng một request nhẹ để phát hiện token hết hạn/quyền sai
        // trước khi tạo album. Nhờ vậy không tạo album dở dang rồi mới báo lỗi.
        try { await drive.about.get({ fields: 'user(emailAddress)' }); }
        catch (error) {
            logDriveDiagnostic('upload-preflight', error);
            throw new Error(`DRIVE_AUTH_INVALID: ${friendlyDriveError(error)}`);
        }

        let folderNameOnDrive;
        let googleDriveFolderId;
        let originalFolderId;
        if (resumeData) {
            folderNameOnDrive = resumeData.folderNameOnDrive;
            googleDriveFolderId = resumeData.googleDriveFolderId;
            originalFolderId = resumeData.originalFolderId || null;
        } else {
            mainWindow.webContents.send('upload-progress', { progress: 2, currentFile: "Đang khởi tạo Album..." });
            folderNameOnDrive = customFolderName ? customFolderName : ('FinderPicture_Album_' + Date.now());
            const folderResource = { name: folderNameOnDrive, mimeType: 'application/vnd.google-apps.folder' };
            if (driveParentId) folderResource.parents = [driveParentId];
            const driveFolder = await drive.files.create({ resource: folderResource, fields: 'id' });
            googleDriveFolderId = driveFolder.data.id;
        }
        if (!originalFolderId) {
            const existingOriginal = await drive.files.list({ q: `'${googleDriveFolderId}' in parents and name = 'ORIGINAL' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: 'files(id)', pageSize: 10 });
            originalFolderId = existingOriginal.data.files?.[0]?.id || null;
        }
        if (!originalFolderId) {
            const originalFolder = await drive.files.create({ resource: { name: 'ORIGINAL', mimeType: 'application/vnd.google-apps.folder', parents: [googleDriveFolderId] }, fields: 'id' });
            originalFolderId = originalFolder.data.id;
        }
        resumableUpload = { folderPath, imageFiles, customFolderName, watermarkToggle, watermarkText, maxSelections, studioName, displayName, studioLogo, accentColor, dueDate, driveParentId, driveParentPath, folderNameOnDrive, googleDriveFolderId, originalFolderId, _queueJobId: uploadJobId };
        upsertUploadJob({ id: uploadJobId, type: 'original', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedFiles: queueState.completedFiles, failedFiles: queueState.failedFiles, resumeData: resumableUpload });

        const existingFiles = await drive.files.list({
            q: `'${originalFolderId}' in parents and trashed = false`,
            fields: 'files(name,size,md5Checksum,appProperties)', pageSize: 1000
        });
        const { filesToUpload, fingerprints } = await selectFilesToUpload(imageFiles, existingFiles.data.files || [], folderPath);

        // Google Drive nhận nhiều file song song nhanh hơn đáng kể. Giới hạn 4
        // luồng để không làm cạn băng thông hoặc bị API giới hạn yêu cầu.
        let nextFileIndex = 0;
        let completedFiles = imageFiles.length - filesToUpload.length;
        queueState.completedFiles = completedFiles;
        let uploadError = null;
        const failedFiles = [];
        const uploadStartedAt = Date.now();
        let lastQueuePersistAt = Date.now();

        async function uploadWorker() {
            while (!uploadError) {
                const index = nextFileIndex++;
                if (index >= filesToUpload.length) return;

                const fileName = filesToUpload[index];
                try {
                    const fingerprint = fingerprints.get(fileName) || await getUploadFingerprint(resolveImagePath(folderPath, fileName));
                    await uploadDriveFileWithRetry(drive, {
                        fileName: path.basename(fileName),
                        parentId: originalFolderId,
                        localPath: resolveImagePath(folderPath, fileName),
                        mimeType: 'image/jpeg',
                        fingerprint
                    });
                    completedFiles++;
                    queueState.completedFiles = completedFiles;
                    // Persist at least once per second (and every five files).
                    // Drive itself is the idempotency source of truth, so a
                    // crash between checkpoints safely skips already-uploaded
                    // names on the next resume without blocking the UI.
                    if (completedFiles % 5 === 0 || Date.now() - lastQueuePersistAt >= 1000) {
                        upsertUploadJob({ id: uploadJobId, type: 'original', status: 'running', completedFiles, failedFiles: queueState.failedFiles });
                        lastQueuePersistAt = Date.now();
                    }
                    const timing = uploadTiming(completedFiles, imageFiles.length, uploadStartedAt);
                    mainWindow.webContents.send('upload-progress', {
                        progress: Math.round((completedFiles / imageFiles.length) * 100),
                        currentFile: `${fileName} (${completedFiles}/${imageFiles.length})`,
                        completed: completedFiles,
                        total: imageFiles.length,
                        failed: failedFiles.length,
                        rate: timing.rate,
                        etaSeconds: timing.etaSeconds
                    });
                } catch (error) {
                    failedFiles.push({ fileName, error: friendlyDriveError(error) });
                    queueState.failedFiles = failedFiles.slice();
                    upsertUploadJob({ id: uploadJobId, type: 'original', status: 'paused', completedFiles, failedFiles: queueState.failedFiles, error: friendlyDriveError(error), resumeData: { ...resumableUpload, _queueJobId: uploadJobId } });
                    uploadError = error;
                    const timing = uploadTiming(completedFiles, imageFiles.length, uploadStartedAt);
                    mainWindow.webContents.send('upload-progress', { progress: Math.round((completedFiles / imageFiles.length) * 100), currentFile: `Lỗi: ${fileName}`, completed: completedFiles, total: imageFiles.length, failed: failedFiles.length, rate: timing.rate, etaSeconds: timing.etaSeconds });
                }
            }
        }

        const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, filesToUpload.length);
        await Promise.all(Array.from({ length: workerCount }, uploadWorker));
        if (uploadError) throw uploadError;
        await Promise.all([googleDriveFolderId, originalFolderId].map(id => revokePublicDrivePermissions(drive, id)));

        // Drive ids may contain `_`; normalize the complete slug so the API
        // resolver and the generated client link always use the same value.
        const publicSlug = slugifyAlbumName(`${folderNameOnDrive}-${String(googleDriveFolderId).slice(-6)}`);
        const wmPayload = JSON.stringify({
            isEnabled: watermarkToggle,
            text: watermarkText,
            maxSelections: maxSelections,
            publicSlug,
            clientName: folderNameOnDrive,
            displayName: String(displayName || 'Finder').trim() || 'Finder',
            originalFolderId,
            // This handler is exclusively the customer-selection flow. Send
            // the type explicitly so a stale/legacy Drive folder cannot be
            // reclassified as a party gallery by a partial settings update.
            galleryType: 'selection',
            partyGallery: false,
            studioName: String(studioName || 'Finder').trim().toUpperCase(),
            studioLogo: studioLogo || '',
            accentColor: accentColor || '#7c8cff'
        });
        const wmOptions = { hostname: ONLINE_DOMAIN, port: 443, path: `/api/album/${googleDriveFolderId}/settings`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wmPayload), ...serverAuthHeaders(), ...driveAccessHeaders(auth), ...albumManagementHeaders(googleDriveFolderId) } };
        let settingsResult = {};
        await new Promise((resolve, reject) => {
            let body = '';
            const wmReq = https.request(wmOptions, (res) => {
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { settingsResult = JSON.parse(body || '{}'); }
                    catch (_) { return reject(new Error(`Không thể lưu cấu hình album (HTTP ${res.statusCode}).`)); }
                    if (res.statusCode >= 400 || !settingsResult.success) return reject(new Error(settingsResult.error || `Không thể lưu cấu hình album (HTTP ${res.statusCode}).`));
                    resolve();
                });
            });
            wmReq.on('error', reject); wmReq.write(wmPayload); wmReq.end();
        });

        // The album token is generated by the settings creation response. Now
        // that the album has a management token, store its Drive session using
        // the server-side encryption path so the public client can use the
        // private image proxy after a cold start.
        try {
            if (settingsResult.managementToken && hasLocalDriveTokens()) {
                const tokens = readLocalDriveTokens();
                await postServerJson(`/api/album/${googleDriveFolderId}/drive-token`, { tokens, driveFolderId: originalFolderId, galleryType: 'selection' }, { ...driveAccessHeaders(auth), 'x-finder-management-token': settingsResult.managementToken });
            }
        } catch (error) { console.warn('Không thể lưu token theo album:', error.message); }

        const publicLink = `https://${ONLINE_DOMAIN}/a/${publicSlug}`;
        
        // HÀM NÀY BÂY GIỜ SẼ LƯU VÀO CẢ MÁY TÍNH VÀ FIREBASE
        saveAlbumToHistory({ 
            id: googleDriveFolderId, 
            name: folderNameOnDrive, 
            date: new Date().toLocaleString('vi-VN'), 
            link: publicLink, 
            publicSlug,
            clientName: folderNameOnDrive,
            displayName: String(displayName || 'Finder').trim() || 'Finder',
            originalFolderId,
            galleryType: 'selection',
            studioName: String(studioName || 'Finder').trim().toUpperCase(),
            studioLogo: studioLogo || '',
            accentColor: accentColor || '#7c8cff',
            paymentStatus: 'unpaid',
            paymentAmount: 0,
            status: "Đang chờ khách chọn", 
            localPath: folderPath, 
            driveParentId: driveParentId || null,
            driveParentPath: driveParentPath || 'Drive của tôi',
            drivePath: `${driveParentPath || 'Drive của tôi'}/${folderNameOnDrive}`,
            maxSelections: parseInt(maxSelections) || 0, 
            watermarkToggle: watermarkToggle,
            watermarkText: watermarkText
            , managementToken: settingsResult.managementToken || settingsResult.settings?.managementToken || null
            , dueDate: dueDate || null
        });

        removeUploadJob(uploadJobId);
        return { success: true, folderLink: publicLink, completed: imageFiles.length, failed: failedFiles.length };
    } catch (error) {
        logDriveDiagnostic('upload-to-drive', error);
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('upload-to-drive-stale', error);
        if (isEmptyJsonError(error)) {
            removeLocalDriveTokens();
            if (resumableUpload) upsertUploadJob({ id: uploadJobId, type: 'original', status: 'paused', completedFiles: queueState.completedFiles, failedFiles: queueState.failedFiles, error: 'DRIVE_EMPTY_RESPONSE', resumeData: { ...resumableUpload, _queueJobId: uploadJobId } });
            return { success: false, error: 'Google Drive trả về phản hồi rỗng khi upload. Phiên đăng nhập cần được cấp lại (DRIVE_EMPTY_RESPONSE). Hãy mở log: ' + DRIVE_LOG_PATH, resumeData: resumableUpload };
        }
        if (resumableUpload) upsertUploadJob({ id: uploadJobId, type: 'original', status: 'paused', completedFiles: queueState.completedFiles, failedFiles: queueState.failedFiles, error: friendlyDriveError(error), resumeData: { ...resumableUpload, _queueJobId: uploadJobId } });
        return { success: false, error: friendlyDriveError(error), resumeData: resumableUpload };
    }
    finally { uploadInProgress = false; }
});

ipcMain.handle('upload-check-to-drive', async (event, payload = {}) => {
    const resumeData = payload.resumeData || null;
    const uploadJobId = resumeData?._queueJobId || crypto.randomUUID();
    const folderId = resumeData?.folderId || payload.folderId;
    const folderPath = resumeData?.folderPath || payload.folderPath;
    const allowCountMismatch = Boolean(payload.allowCountMismatch || resumeData?.allowCountMismatch);
    const history = getAlbumHistory();
    const album = history.find(item => item.id === folderId);
    if (!album) return { success: false, error: 'Không tìm thấy album trong thư viện.' };
    if (!folderPath || !fs.existsSync(folderPath)) return { success: false, error: 'Thư mục CHECK không tồn tại.' };

    const imageFiles = (await fs.promises.readdir(folderPath)).filter(file => /\.(jpe?g|png|webp)$/i.test(file));
    if (!imageFiles.length) return { success: false, error: 'Thư mục CHECK không có ảnh hợp lệ.' };

    let selectedCount = null;
    try {
        const selectedData = await getServerJson(`/api/album/${folderId}/liked/all`, serverAuthHeaders());
        selectedCount = Object.keys(selectedData.liked_files || {}).length;
    } catch (error) {
        console.warn('Không thể đối chiếu số ảnh CHECK:', error.message);
    }
    if (selectedCount !== null && selectedCount !== imageFiles.length && !allowCountMismatch) {
        return {
            success: false,
            code: 'CHECK_COUNT_MISMATCH',
            requiresConfirmation: true,
            selectedCount,
            checkCount: imageFiles.length,
            error: `Khách đã chọn ${selectedCount} ảnh nhưng thư mục CHECK có ${imageFiles.length} ảnh.`
        };
    }

    let currentCheckFolderId = resumeData?.checkFolderId || album.checkFolderId || null;
    try {
        uploadInProgress = true;
        mainWindow.webContents.send('check-upload-progress', { progress: 0, currentFile: 'Đang kết nối Google Drive…' });
        const auth = await authenticateCasi(true);
        const drive = google.drive({ version: 'v3', auth });
        let checkFolderId = currentCheckFolderId;
        const nextCheckVersion = album.checkVersion
            ? Math.max(1, Number(album.checkVersion) + 1)
            : (album.checkFolderId ? 2 : 1);
        const nextCheckFolderName = nextCheckVersion === 1 ? 'CHECK' : `CHECK ${nextCheckVersion}`;

        // Mỗi lần upload CHECK mới tạo một thư mục phiên bản mới; link album
        // vẫn giữ nguyên vì server sẽ trỏ current checkFolderId sang phiên bản này.
        checkFolderId = null;
        if (!checkFolderId) {
            const existing = await drive.files.list({
                q: `'${folderId}' in parents and name = '${nextCheckFolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id, name)', pageSize: 10
            });
            checkFolderId = existing.data.files?.[0]?.id || null;
        }
        if (!checkFolderId) {
            const created = await drive.files.create({
                resource: { name: nextCheckFolderName, mimeType: 'application/vnd.google-apps.folder', parents: [folderId] },
                fields: 'id'
            });
            checkFolderId = created.data.id;
        }
        currentCheckFolderId = checkFolderId;

        const resumableCheck = { folderId, folderPath, allowCountMismatch: true, checkFolderId, _queueJobId: uploadJobId };
        upsertUploadJob({ id: uploadJobId, type: 'check', status: 'running', createdAt: new Date().toISOString(), completedFiles: 0, failedFiles: [], resumeData: resumableCheck });

        const existingFiles = await drive.files.list({
            q: `'${checkFolderId}' in parents and trashed = false`,
            fields: 'files(name,size,md5Checksum,appProperties)', pageSize: 1000
        });
        const { filesToUpload, fingerprints } = await selectFilesToUpload(imageFiles, existingFiles.data.files || [], folderPath);
        let completed = imageFiles.length - filesToUpload.length;
        let nextIndex = 0;
        let uploadError = null;
        let failed = 0;
        const uploadStartedAt = Date.now();

        const uploadWorker = async () => {
            while (!uploadError) {
                const index = nextIndex++;
                if (index >= filesToUpload.length) return;
                const fileName = filesToUpload[index];
                try {
                    const ext = path.extname(fileName).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                    const fingerprint = fingerprints.get(fileName) || await getUploadFingerprint(resolveImagePath(folderPath, fileName));
                    await uploadDriveFileWithRetry(drive, {
                        fileName: path.basename(fileName),
                        parentId: checkFolderId,
                        localPath: resolveImagePath(folderPath, fileName),
                        mimeType,
                        fingerprint
                    });
                    completed++;
                    upsertUploadJob({ id: uploadJobId, type: 'check', status: 'running', completedFiles: completed, failedFiles: failed, resumeData: resumableCheck });
                    const timing = uploadTiming(completed, imageFiles.length, uploadStartedAt);
                    mainWindow.webContents.send('check-upload-progress', { progress: Math.round((completed / imageFiles.length) * 100), currentFile: `${fileName} (${completed}/${imageFiles.length})`, completed, total: imageFiles.length, failed: 0, rate: timing.rate, etaSeconds: timing.etaSeconds });
                } catch (error) { failed++; uploadError = error; const timing = uploadTiming(completed, imageFiles.length, uploadStartedAt); mainWindow.webContents.send('check-upload-progress', { progress: Math.round((completed / imageFiles.length) * 100), currentFile: 'Lỗi: ' + fileName, completed, total: imageFiles.length, failed, rate: timing.rate, etaSeconds: timing.etaSeconds }); }
            }
        };

        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, Math.max(1, filesToUpload.length)) }, uploadWorker));
        if (uploadError) throw uploadError;
        await revokePublicDrivePermissions(drive, checkFolderId);
        await postServerJson(`/api/album/${folderId}/check`, { checkFolderId, checkImageCount: imageFiles.length, version: nextCheckVersion }, { ...serverAuthHeaders(), ...driveAccessHeaders(auth), ...albumManagementHeaders(folderId) });
        const index = history.findIndex(item => item.id === folderId);
        const checkData = { checkFolderId, checkVersion: nextCheckVersion, checkLocalPath: folderPath, checkImageCount: imageFiles.length, checkStatus: 'ready', checkUpdatedAt: new Date().toISOString(), status: `CHECK ${nextCheckVersion} · chờ khách kiểm tra` };
        if (index !== -1) {
            Object.assign(history[index], checkData);
            const previous = history[index].statusHistory?.at(-1)?.status;
            if (previous !== checkData.status) {
                history[index].statusHistory = Array.isArray(history[index].statusHistory) ? history[index].statusHistory : [];
                history[index].statusHistory.push({ status: checkData.status, at: checkData.checkUpdatedAt, source: 'check-upload' });
                history[index].statusHistory = history[index].statusHistory.slice(-30);
            }
            fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
            syncHistoryToServer(history[index]);
        }
        mainWindow.webContents.send('check-upload-progress', { progress: 100, currentFile: 'Đã hoàn tất thư mục CHECK.' });
        removeUploadJob(uploadJobId);
        return { success: true, count: imageFiles.length, selectedCount, countMatched: selectedCount === null || selectedCount === imageFiles.length, checkFolderId };
    } catch (error) {
        logDriveDiagnostic('upload-check-to-drive', error);
        if (isStaleDriveCredentialError(error)) clearStaleDriveSession('upload-check-to-drive-stale', error);
        upsertUploadJob({ id: uploadJobId, type: 'check', status: 'paused', error: friendlyDriveError(error), resumeData: { folderId, folderPath, allowCountMismatch: true, checkFolderId: currentCheckFolderId, _queueJobId: uploadJobId } });
        return { success: false, error: friendlyDriveError(error) };
    } finally { uploadInProgress = false; }
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
    const historyIndex = history.findIndex(item => item.id === folderId);
    const rawSyncData = { rawSynced: true, rawSyncedAt: new Date().toISOString(), status: 'Đang edit' };
    if (historyIndex !== -1) {
        Object.assign(history[historyIndex], rawSyncData);
        history[historyIndex].statusHistory = Array.isArray(history[historyIndex].statusHistory) ? history[historyIndex].statusHistory : [];
        if (history[historyIndex].statusHistory.at(-1)?.status !== rawSyncData.status) history[historyIndex].statusHistory.push({ status: rawSyncData.status, at: rawSyncData.rawSyncedAt, source: 'raw-sync' });
        history[historyIndex].statusHistory = history[historyIndex].statusHistory.slice(-30);
        fs.writeFileSync(getStudioHistoryFilePath(), JSON.stringify(history, null, 2), 'utf8');
        syncHistoryToServer(history[historyIndex]);
    }
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
