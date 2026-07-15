const test = require('node:test');
const assert = require('node:assert/strict');
const {
    slugifyAlbumName,
    canonicalPublicSlug,
    normalizeDriveFolderId,
    escapeHtmlAttribute
} = require('../server/public-slug');

test('public album slugs are stable for Vietnamese names', () => {
    assert.equal(slugifyAlbumName('13-07 - LÁ TRANG'), '13-07-la-trang');
    assert.equal(canonicalPublicSlug('13-07_LA-TRANG'), '13-07-la-trang');
    assert.equal(slugifyAlbumName(''), 'album');
});

test('Drive folder ids reject path sentinels without changing valid ids', () => {
    assert.equal(normalizeDriveFolderId('.', 'fallback-id'), 'fallback-id');
    assert.equal(normalizeDriveFolderId('..', 'fallback-id'), 'fallback-id');
    assert.equal(normalizeDriveFolderId(' drive-root-123 '), 'drive-root-123');
});

test('social metadata escapes attribute values', () => {
    assert.equal(escapeHtmlAttribute('<Finder & Studio>'), '&lt;Finder &amp; Studio&gt;');
});
