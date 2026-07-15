/** Pure helpers shared by public album routes and Drive recovery paths. */
function slugifyAlbumName(value = '') {
    return String(value)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'album';
}

function canonicalPublicSlug(value = '') {
    return slugifyAlbumName(value);
}

function normalizeDriveFolderId(value, fallback = '') {
    const id = String(value || '').trim();
    if (!id || id === '.' || id === '..') return String(fallback || '').trim();
    return id;
}

function escapeHtmlAttribute(value = '') {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

module.exports = {
    slugifyAlbumName,
    canonicalPublicSlug,
    normalizeDriveFolderId,
    escapeHtmlAttribute
};
