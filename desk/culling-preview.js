const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const sharp = require('sharp');

function cleanupCullingPreviewCache(cacheDir, maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const cutoff = Date.now() - maxAgeMs;
        for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue;
            const previewPath = path.join(cacheDir, entry.name);
            try {
                if (fs.statSync(previewPath).mtimeMs < cutoff) fs.unlinkSync(previewPath);
            } catch (_) {}
        }
    } catch (_) {}
}

async function createCullingPreview({ cacheDir, folderPath, file, width, height, quality, resolveImagePath }) {
    const fullPath = resolveImagePath(folderPath, file);
    if (!fs.existsSync(fullPath)) throw new Error('Tệp ảnh không còn tồn tại.');
    fs.mkdirSync(cacheDir, { recursive: true });
    const stat = fs.statSync(fullPath);
    const key = crypto.createHash('sha256')
        .update(`${fullPath}\0${stat.size}\0${stat.mtimeMs}\0${width}x${height}q${quality}`)
        .digest('hex');
    const previewPath = path.join(cacheDir, `${key}.jpg`);
    if (!fs.existsSync(previewPath)) {
        await sharp(fullPath)
            .rotate()
            .resize({ width, height, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality, progressive: true })
            .toFile(previewPath);
    }
    return pathToFileURL(previewPath).href;
}

module.exports = { cleanupCullingPreviewCache, createCullingPreview };
