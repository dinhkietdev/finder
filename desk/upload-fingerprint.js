const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const uploadFingerprintCache = new Map();

function resolveImagePath(folderPath, fileName) {
    const root = path.resolve(String(folderPath || ''));
    const safeName = path.basename(String(fileName || ''));
    const target = path.resolve(root, safeName);
    if (!safeName || (target !== root && !target.startsWith(`${root}${path.sep}`))) throw new Error('Tên tệp ảnh không hợp lệ.');
    return target;
}

async function getUploadFingerprint(localPath) {
    const stat = await fs.promises.stat(localPath);
    const cacheKey = `${localPath}:${stat.size}:${stat.mtimeMs}`;
    const cached = uploadFingerprintCache.get(cacheKey);
    if (cached) return cached;
    const md5 = crypto.createHash('md5');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(localPath);
        stream.on('data', chunk => md5.update(chunk));
        stream.once('error', reject);
        stream.once('end', resolve);
    });
    const fingerprint = { size: String(stat.size), md5Checksum: md5.digest('hex') };
    uploadFingerprintCache.set(cacheKey, fingerprint);
    if (uploadFingerprintCache.size > 2000) uploadFingerprintCache.delete(uploadFingerprintCache.keys().next().value);
    return fingerprint;
}

async function selectFilesToUpload(imageFiles, existingFiles, folderPath) {
    const byName = new Map();
    for (const file of existingFiles || []) {
        const name = String(file.name || '');
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(file);
    }
    const filesToUpload = [];
    const fingerprints = new Map();
    for (const file of imageFiles) {
        const name = path.basename(file);
        const candidates = byName.get(name) || [];
        if (!candidates.length) {
            filesToUpload.push(file);
            continue;
        }
        const localPath = resolveImagePath(folderPath, file);
        const fingerprint = await getUploadFingerprint(localPath);
        const sameContent = candidates.some(existing => String(existing.size || '') === fingerprint.size
            && (!existing.md5Checksum || existing.md5Checksum === fingerprint.md5Checksum));
        if (!sameContent) filesToUpload.push(file);
        else fingerprints.set(file, fingerprint);
    }
    return { filesToUpload, fingerprints };
}

module.exports = { resolveImagePath, getUploadFingerprint, selectFilesToUpload };
