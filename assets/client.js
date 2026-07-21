        const ONLINE_SERVER = 'https://finder-swart-pi.vercel.app';
        const urlParams = new URLSearchParams(window.location.search);
        // The public `/a/:slug` shell can embed the resolved folder id. This
        // removes a second round-trip before the album API request. Keep the
        // query-string fallback for older links and direct desktop launches.
        let folderId = window.__FINDER_ALBUM_BOOTSTRAP__?.folderId || urlParams.get('id');
        const albumSlug = window.location.pathname.match(/^\/a\/([^/]+)/)?.[1] || '';
        // Keep only a small metadata bootstrap in localStorage.  The actual
        // image bytes remain on Drive/Vercel; this cache is intentionally
        // short-lived so a visitor opening the same Messenger/Zalo link can
        // see the first screen immediately while the server refreshes it.
        const CLIENT_BOOTSTRAP_CACHE_VERSION = 2;
        const CLIENT_BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
        const CLIENT_BOOTSTRAP_CACHE_MAX_IMAGES = 120;
        const CLIENT_BOOTSTRAP_CACHE_MAX_CHECK_IMAGES = 60;
        const CLIENT_VIEW_STATE_VERSION = 1;
        const CLIENT_VIEW_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

        const state = {
            images: [],
            originalImages: [],
            checkImages: [],
            currentIndex: 0,
            isLoading: false,
            maxSelections: 0,
            isFinalized: false,
            viewMode: 'original',
            checkReady: false,
            checkFolderId: null,
            checkUpdatedAt: null,
            checkVersion: 0,
            checkNeedsRevision: false,
            workflowStatus: 'selection_open',
            galleryType: 'selection',
            gallerySections: [],
            activeGallerySection: 'all',
            driveFolderId: '',
            expiresDays: 60,
            expiresAt: null,
            aiGroups: [],
            // While analysis is running, keep the normal gallery visible.
            // Once the complete group list is ready, the accordion opens the
            // groups automatically (unless the visitor explicitly toggled it).
            aiGroupsExpanded: false,
            galleryExpanded: true,
            aiAccordionUserInteracted: false,
            activeAiGroupIndex: null,
            publicSlug: albumSlug,
            studioName: 'Finder',
            displayName: 'Finder',
            compareEnabled: false,
            selectionReopenedAt: null,
            selectionConfirmedAt: null,
            pageCursor: null,
            pageHasMore: false,
            pageLoading: false,
            pagesPending: false,
            initialLoadPending: false,
            metadataPending: false,
            aiAnalysisPending: false,
            aiAnalysisProcessed: 0,
            aiAnalysisTotal: 0,
            aiGroupsComplete: false,
            aiGroupSourceCount: 0,
            cacheHydrated: false,
            savedViewState: null,
            savedViewStateLoaded: false,
            viewStateRestored: false,
            pendingViewFullName: '',
            likedList: {},
            checkNotes: {}
        };
        const savingFiles = new Set();

        const elements = {
            mainImage: document.getElementById('mainImage'),
            contentGrid: document.getElementById('contentGrid'),
            currentImageSection: document.getElementById('currentImageSection'),
            selectedImagesSection: document.getElementById('selectedImagesSection'),
            jumpToCurrent: document.getElementById('jumpToCurrent'),
            jumpToSelected: document.getElementById('jumpToSelected'),
            photoName: document.getElementById('photoName'),
            photoIndexLabel: document.getElementById('photoIndexLabel'),
            selectedCountLabel: document.getElementById('selectedCountLabel'),
            photoStatusBadge: document.getElementById('photoStatusBadge'),
            swipeHint: document.getElementById('swipeHint'),
            noteInput: document.getElementById('noteInput'),
            imageActionRow: document.getElementById('imageActionRow'),
            statusMessage: document.getElementById('statusMessage'),
            selectionList: document.getElementById('selectionList'),
            thumbStrip: document.getElementById('thumbStrip'),
            selectBtn: document.getElementById('selectBtn'),
            saveNoteBtn: document.getElementById('saveNoteBtn'),
            confirmAllBtn: document.getElementById('confirmAllBtn'),
            prevBtn: document.getElementById('prevBtn'),
            nextBtn: document.getElementById('nextBtn'),
            viewerShell: document.getElementById('viewerShell'),
            finalizedBanner: document.getElementById('finalizedBanner'),
            checkReadyBanner: document.getElementById('checkReadyBanner'),
            reviewModeBar: document.getElementById('reviewModeBar'),
            checkModeBtn: document.getElementById('checkModeBtn'),
            originalModeBtn: document.getElementById('originalModeBtn'),
            checkAcceptBtn: document.getElementById('checkAcceptBtn'),
            imageLightbox: document.getElementById('imageLightbox'),
            lightboxImage: document.getElementById('lightboxImage'),
            lightboxLoading: document.getElementById('lightboxLoading'),
            closeLightboxBtn: document.getElementById('closeLightboxBtn'),
            lightboxSelectBtn: document.getElementById('lightboxSelectBtn'),
            lightboxNoteBtn: document.getElementById('lightboxNoteBtn'),
            quickNoteModal: document.getElementById('quickNoteModal'),
            quickNoteInput: document.getElementById('quickNoteInput'),
            quickNoteSaveBtn: document.getElementById('quickNoteSaveBtn'),
            quickNoteCancelBtn: document.getElementById('quickNoteCancelBtn'),
            helpRobot: document.getElementById('helpRobot'),
            robotButton: document.getElementById('robotButton'),
            robotMessage: document.querySelector('#helpRobot .robot-message'),
            noteSection: document.getElementById('noteSection'),
            galleryCount: document.getElementById('galleryCount')
            ,gallerySectionsNav: document.getElementById('gallerySectionsNav')
            ,driveGalleryActions: document.getElementById('driveGalleryActions'), driveAccessBtn: document.getElementById('driveAccessBtn')
            ,partyGalleryActions: document.getElementById('partyGalleryActions'), partySelectAllBtn: document.getElementById('partySelectAllBtn'), partyDownloadBtn: document.getElementById('partyDownloadBtn'), partyDownloadQueue: document.getElementById('partyDownloadQueue'), partyDownloadQueueText: document.getElementById('partyDownloadQueueText'), partyDownloadNextBtn: document.getElementById('partyDownloadNextBtn'), partyDownloadCancelBtn: document.getElementById('partyDownloadCancelBtn')
            ,aiPicksPanel: document.getElementById('aiPicksPanel'), aiPicksGrid: document.getElementById('aiPicksGrid'), aiPicksCount: document.getElementById('aiPicksCount'), aiPicksDescription: document.getElementById('aiPicksDescription'),
            aiPicksToggle: document.getElementById('aiPicksToggle'), aiPicksToggleLabel: document.getElementById('aiPicksToggleLabel'), galleryPanel: document.getElementById('galleryPanel'),
            galleryToggle: document.getElementById('galleryToggle'), galleryToggleLabel: document.getElementById('galleryToggleLabel'),
            albumLoadingModal: document.getElementById('albumLoadingModal'), albumLoadingProgress: document.getElementById('albumLoadingProgress'),
            aiLoadingNotice: document.getElementById('aiLoadingNotice'),
            brandTitle: document.getElementById('brandTitle'),
            albumStatusPill: document.getElementById('albumStatusPill'),
            copyShareBtn: document.getElementById('copyShareBtn'), showQrBtn: document.getElementById('showQrBtn'),
            compareStage: document.getElementById('compareStage'), compareOriginalImage: document.getElementById('compareOriginalImage'), compareCheckImage: document.getElementById('compareCheckImage'), compareClip: document.getElementById('compareClip'), compareDivider: document.getElementById('compareDivider'), compareRange: document.getElementById('compareRange'), compareToggleBtn: document.getElementById('compareToggleBtn'), lightboxDownloadBtn: document.getElementById('lightboxDownloadBtn'),
            lightboxGroupContext: document.getElementById('lightboxGroupContext'),
            qrModal: document.getElementById('qrModal'), qrImage: document.getElementById('qrImage'), qrLinkText: document.getElementById('qrLinkText'), closeQrBtn: document.getElementById('closeQrBtn')
            ,selectionReopenModal: document.getElementById('selectionReopenModal'), reopenOriginalBtn: document.getElementById('reopenOriginalBtn'), reopenCheckBtn: document.getElementById('reopenCheckBtn')
        };
        const partySelected = new Set();
        let partyDownloadQueue = [];
        let partyDownloadIndex = 0;
        let partyDownloadBusy = false;
        let zoomScale = 1;
        let robotMessageTimeout = null;
        let robotMessageInterval = null;
        let robotIdleTimer = null;
        let robotPromptIndex = 0;
        let robotContactShownAt = 0;
        const ROBOT_CONTACT_COOLDOWN_MS = 3 * 60 * 1000;
        const ROBOT_FACEBOOK_URL = 'https://www.facebook.com/inhkiet.704955';
        const ROBOT_CONTACT_PROMPT = Object.freeze({
            prefix: '📷 Đình Kiệt có nhận chụp ảnh nhé, liên hệ em ở đây: ',
            linkText: 'Đình Kiệt',
            href: ROBOT_FACEBOOK_URL
        });
        let expiryTimer = null;
        let pinchStartDistance = 0;
        let pinchStartScale = 1;
        let panX = 0;
        let panY = 0;
        let panPointer = null;
        let lightboxSwipeStart = null;
        let lastLightboxSwipeAt = 0;
        let lightboxPointerMoved = false;
        let suppressLightboxCloseUntil = 0;
        let lightboxPanStart = null;
        let aiGroupingTimer = null;
        let aiGroupingRunId = 0;
        let thumbRenderVersion = 0;
        let thumbRenderKey = '';
        const thumbButtonsByIndex = new Map();
        // Keep only a small set of in-flight/completed warmups. The browser
        // owns the decoded image cache; this map prevents duplicate requests
        // while quickly navigating between lightbox images.
        const lightboxWarmCache = new Map();
        const LIGHTBOX_WARM_CACHE_LIMIT = 12;
        const nearbyImageWarmCache = new Set();
        const NEARBY_IMAGE_WARM_CACHE_LIMIT = 16;
        const activePointers = new Map();
        const thumbObserver = 'IntersectionObserver' in window
            ? new IntersectionObserver(entries => entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const image = entry.target;
                const button = image.closest('.thumb-btn');
                image.src = image.dataset.src || '';
                image.addEventListener('load', () => { image.classList.add('is-ready'); button?.classList.add('is-ready'); }, { once:true });
                thumbObserver.unobserve(image);
            }), { rootMargin:'360px 0px' })
            : null;
        const aiGroupObserver = 'IntersectionObserver' in window
            ? new IntersectionObserver(entries => entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                hydrateAiGroupCard(entry.target);
                aiGroupObserver.unobserve(entry.target);
            }), { rootMargin:'320px 0px' })
            : null;

        function hydrateAiGroupCard(card) {
            if (!card || card.dataset.hydrated === 'true') return;
            const image = card.querySelector('img[data-src]');
            if (!image) {
                card.classList.add('is-ready');
                card.dataset.hydrated = 'true';
                return;
            }
            const src = image.dataset.src || '';
            image.removeAttribute('data-src');
            card.dataset.hydrated = 'true';
            const markReady = () => {
                image.classList.add('is-ready');
                card.classList.add('is-ready');
            };
            image.addEventListener('load', markReady, { once:true });
            image.addEventListener('error', markReady, { once:true });
            if (!src) return markReady();
            image.src = src;
        }

        function setMessage(message, type = 'info') {
            elements.statusMessage.textContent = message;
            elements.statusMessage.className = 'status-message';
            if (type === 'error') elements.statusMessage.classList.add('error');
            if (type === 'success') elements.statusMessage.classList.add('success');
        }

        function setAlbumLoadingVisible(visible) {
            const modal = elements.albumLoadingModal;
            if (!modal) return;
            modal.classList.toggle('open', !!visible);
            modal.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }

        function updateAlbumLoadingOverlay() {
            updateAiLoadingNotice();
            if (!state.initialLoadPending) {
                setAlbumLoadingVisible(false);
                return;
            }
            // Only the first paint is blocking. Metadata, later Drive pages
            // and similarity analysis continue in the background after the
            // first thumbnail is visible.
            const busy = state.pageLoading || (!state.originalImages.length && state.metadataPending);
            if (!busy) {
                state.initialLoadPending = false;
                setAlbumLoadingVisible(false);
                return;
            }
            const progress = [];
            if (state.originalImages.length || state.checkImages.length) {
                const imageCount = state.originalImages.length + (state.checkImages.length ? ` · ${state.checkImages.length} CHECK` : '');
                progress.push(`Đã nhận ${imageCount} ảnh` + (state.pagesPending || state.pageLoading ? ', đang tải tiếp...' : ''));
            } else {
                progress.push('Đang tải ảnh đầu tiên...');
            }
            if (elements.albumLoadingProgress) elements.albumLoadingProgress.textContent = progress.join(' ');
            setAlbumLoadingVisible(true);
        }

        function updateAiLoadingNotice() {
            const notice = elements.aiLoadingNotice;
            if (!notice) return;
            const active = state.viewMode === 'original'
                && state.galleryType !== 'party'
                && !state.isFinalized
                && state.workflowStatus !== 'completed'
                && (state.initialLoadPending || state.pagesPending || state.pageLoading || state.aiAnalysisPending);
            notice.classList.toggle('visible', active);
            notice.setAttribute('aria-hidden', active ? 'false' : 'true');
        }

        function escapeHtml(value = '') {
            return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
        }

        async function readApiJson(response, fallbackMessage = 'Máy chủ trả về phản hồi không hợp lệ.') {
            const raw = await response.text();
            let data = {};
            try { data = raw ? JSON.parse(raw) : {}; }
            catch (_) { throw new Error(`${fallbackMessage} (HTTP ${response.status})${raw ? `: ${raw.slice(0, 180)}` : ''}`); }
            if (!response.ok || data.success === false) {
                const requestId = response.headers.get('x-request-id') || data.requestId;
                throw new Error(`${data.error || data.message || `${fallbackMessage} (HTTP ${response.status})`}${requestId ? ` [requestId=${requestId}]` : ''}`);
            }
            return data;
        }

        function getCurrentImage() {
            return state.images[state.currentIndex] || null;
        }

        function getProtectedDriveImageUrl(image, size = 'original', download = true) {
            if (!image?.id || !folderId) return '';
            const query = new URLSearchParams({ size });
            if (download) query.set('download', '1');
            return `${ONLINE_SERVER}/api/album/${encodeURIComponent(folderId)}/image/${encodeURIComponent(image.id)}?${query.toString()}`;
        }

        function mapAlbumImage(file) {
            const image = {
                ...file,
                fullName: file.fullName || file.shortName || '',
                shortName: file.shortName || file.fullName || '',
                selected: false,
                note: ''
            };
            image.thumbnail = image.thumbnail || getProtectedDriveImageUrl(image, 'thumb', false);
            image.preview = image.preview || getProtectedDriveImageUrl(image, 'preview', false);
            image.lightbox = image.lightbox || getProtectedDriveImageUrl(image, 'lightbox', false);
            image.originalUrl = image.originalUrl || getProtectedDriveImageUrl(image, 'original', true);
            return image;
        }

        function getClientBootstrapCacheKey() {
            const identity = albumSlug || folderId || 'unknown';
            return `finder-client-bootstrap:${CLIENT_BOOTSTRAP_CACHE_VERSION}:${ONLINE_SERVER}:${identity}`;
        }

        function getClientViewStateKey() {
            const identity = albumSlug || folderId || 'unknown';
            return `finder-client-view:${CLIENT_VIEW_STATE_VERSION}:${ONLINE_SERVER}:${identity}`;
        }

        function readClientViewState() {
            if (state.savedViewStateLoaded) return state.savedViewState;
            state.savedViewStateLoaded = true;
            try {
                const saved = JSON.parse(localStorage.getItem(getClientViewStateKey()) || 'null');
                if (!saved || saved.version !== CLIENT_VIEW_STATE_VERSION || !saved.savedAt) return null;
                if (Date.now() - Number(saved.savedAt) > CLIENT_VIEW_STATE_TTL_MS) return null;
                state.savedViewState = saved;
                return saved;
            } catch (_) {
                return null;
            }
        }

        function applyClientViewState() {
            if (state.viewStateRestored) return;
            const saved = readClientViewState();
            if (!saved) {
                state.viewStateRestored = true;
                return;
            }
            const requestedCheck = saved.viewMode === 'check';
            // CHECK may arrive after the first page/meta response. Keep the
            // restore pending until that list is available instead of
            // overwriting the saved position with the first original image.
            if (requestedCheck && !state.checkReady) {
                state.pendingViewFullName = String(saved.fullName || '');
                return;
            }
            state.viewMode = requestedCheck && state.checkReady ? 'check' : 'original';
            state.images = state.viewMode === 'check' ? state.checkImages : state.originalImages;
            if (state.galleryType === 'party' && saved.gallerySection) {
                const sectionExists = state.gallerySections.some(section => String(section.id || section.driveFolderId) === String(saved.gallerySection));
                if (sectionExists) state.activeGallerySection = String(saved.gallerySection);
            }
            if (state.galleryType === 'party' && state.activeGallerySection !== 'all') {
                const sectionId = String(state.activeGallerySection);
                state.images = state.images.filter(image => String(image.gallerySectionId || '') === sectionId);
            }
            state.activeAiGroupIndex = Number.isInteger(Number(saved.activeAiGroupIndex)) ? Number(saved.activeAiGroupIndex) : null;
            const desiredName = String(saved.fullName || '');
            const restoredIndex = desiredName ? state.images.findIndex(image => image.fullName === desiredName) : -1;
            if (restoredIndex >= 0) {
                state.currentIndex = restoredIndex;
                state.pendingViewFullName = '';
                state.viewStateRestored = true;
                return;
            }
            if (desiredName) {
                state.pendingViewFullName = desiredName;
                // The remaining cursor pages will call this function again.
                return;
            }
            const fallbackIndex = Number(saved.currentIndex);
            state.currentIndex = Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < state.images.length ? fallbackIndex : 0;
            state.viewStateRestored = true;
        }

        function finalizeClientViewState() {
            if (state.viewStateRestored || state.pagesPending || state.pageLoading || state.metadataPending) return;
            const saved = readClientViewState();
            // A stale/deleted CHECK image must not leave the page in a blank
            // mode forever. Fall back to the first available original image.
            if (saved?.viewMode === 'check' && !state.checkReady) {
                state.viewMode = 'original';
                state.images = state.originalImages;
                state.currentIndex = 0;
            }
            state.pendingViewFullName = '';
            state.viewStateRestored = true;
        }

        function persistClientViewState() {
            if (!folderId || !state.viewStateRestored) return;
            const current = getCurrentImage();
            if (!current) return;
            try {
                localStorage.setItem(getClientViewStateKey(), JSON.stringify({
                    version: CLIENT_VIEW_STATE_VERSION,
                    savedAt: Date.now(),
                    fullName: current.fullName || current.shortName || '',
                    currentIndex: state.currentIndex,
                    viewMode: state.viewMode,
                    gallerySection: state.galleryType === 'party' ? state.activeGallerySection : null,
                    activeAiGroupIndex: Number.isInteger(state.activeAiGroupIndex) ? state.activeAiGroupIndex : null
                }));
            } catch (_) {
                // Storage can be unavailable in private/in-app browsers; the
                // online gallery must continue without position persistence.
            }
        }

        let clientViewStateWriteTimer = null;
        function scheduleClientViewStatePersist() {
            window.clearTimeout(clientViewStateWriteTimer);
            clientViewStateWriteTimer = window.setTimeout(() => {
                clientViewStateWriteTimer = null;
                persistClientViewState();
            }, 120);
        }

        function serializeClientImage(image) {
            if (!image) return null;
            return {
                id: image.id || null,
                name: image.name || null,
                fullName: image.fullName || image.shortName || '',
                shortName: image.shortName || image.fullName || '',
                thumbnail: image.thumbnail || '',
                preview: image.preview || '',
                lightbox: image.lightbox || '',
                originalUrl: image.originalUrl || '',
                gallerySectionId: image.gallerySectionId || null
            };
        }

        function getClientBootstrapSettings() {
            return {
                galleryType: state.galleryType,
                gallerySections: state.gallerySections,
                expiresDays: state.expiresDays,
                checkFolderId: state.checkFolderId,
                checkUpdatedAt: state.checkUpdatedAt,
                checkVersion: state.checkVersion,
                checkNeedsRevision: state.checkNeedsRevision,
                workflowStatus: state.workflowStatus,
                expiresAt: state.expiresAt,
                publicSlug: state.publicSlug,
                studioName: state.studioName,
                displayName: state.displayName,
                maxSelections: state.maxSelections
            };
        }

        function writeClientBootstrapCache() {
            if (!folderId || !state.originalImages.length) return;
            try {
                const payload = {
                    version: CLIENT_BOOTSTRAP_CACHE_VERSION,
                    savedAt: Date.now(),
                    folderId,
                    publicSlug: state.publicSlug || albumSlug,
                    settings: getClientBootstrapSettings(),
                    isFinalized: state.isFinalized,
                    originalImages: state.originalImages.slice(0, CLIENT_BOOTSTRAP_CACHE_MAX_IMAGES).map(serializeClientImage).filter(Boolean),
                    checkImages: state.checkImages.slice(0, CLIENT_BOOTSTRAP_CACHE_MAX_CHECK_IMAGES).map(serializeClientImage).filter(Boolean)
                };
                localStorage.setItem(getClientBootstrapCacheKey(), JSON.stringify(payload));
            } catch (_) {
                // Private browsing mode, a full quota, or disabled storage
                // must never prevent the online album from loading.
            }
        }

        function hydrateClientBootstrapCache() {
            try {
                const cached = JSON.parse(localStorage.getItem(getClientBootstrapCacheKey()) || 'null');
                if (!cached || cached.version !== CLIENT_BOOTSTRAP_CACHE_VERSION || !cached.savedAt) return false;
                if (Date.now() - Number(cached.savedAt) > CLIENT_BOOTSTRAP_CACHE_TTL_MS) return false;
                if (!folderId && cached.folderId) folderId = cached.folderId;
                if (!folderId || !Array.isArray(cached.originalImages) || !cached.originalImages.length) return false;
                state.cacheHydrated = true;
                state.publicSlug = cached.publicSlug || state.publicSlug || albumSlug;
                applyAlbumSettings(cached.settings || {}, cached.isFinalized, cached.settings?.gallerySections || []);
                state.originalImages = cached.originalImages.map(mapAlbumImage).sort(naturalImageCompare);
                state.checkImages = Array.isArray(cached.checkImages) ? cached.checkImages.map(mapAlbumImage).sort(naturalImageCompare) : [];
                state.checkReady = Boolean(state.checkFolderId && state.checkImages.length);
                state.images = state.originalImages;
                state.currentIndex = 0;
                state.aiGroups = [];
                // The cursor is intentionally not cached: Drive cursors can
                // expire. The next online response will provide a fresh one.
                state.pageCursor = null;
                state.pageHasMore = true;
                state.pagesPending = true;
                applyClientViewState();
                return true;
            } catch (_) {
                return false;
            }
        }

        function applyMetadataToImages(images) {
            const likedList = state.likedList || {};
            const checkNotes = state.checkNotes || {};
            (images || []).forEach(item => {
                const savedData = likedList[item.fullName];
                if (savedData && typeof savedData === 'object') {
                    item.selected = !!savedData.isLiked;
                    item.note = savedData.note || '';
                }
                if (state.checkImages.includes(item) && checkNotes[item.fullName] !== undefined) {
                    item.note = checkNotes[item.fullName] || '';
                }
            });
        }

        function mergeAlbumImages(target, incoming) {
            const seen = new Set(target.map(item => item.id || item.fullName));
            incoming.forEach(item => {
                const key = item.id || item.fullName;
                if (!seen.has(key)) {
                    target.push(item);
                    seen.add(key);
                }
            });
            target.sort(naturalImageCompare);
            applyMetadataToImages(incoming);
        }

        function warmLightboxImage(url, priority = 'low') {
            const source = String(url || '');
            if (!source) return Promise.resolve(false);
            const cached = lightboxWarmCache.get(source);
            if (cached) return cached;
            const promise = new Promise(resolve => {
                const image = new Image();
                image.decoding = 'async';
                image.fetchPriority = priority;
                image.onload = () => resolve(true);
                image.onerror = () => resolve(false);
                image.src = source;
            });
            lightboxWarmCache.set(source, promise);
            if (lightboxWarmCache.size > LIGHTBOX_WARM_CACHE_LIMIT) {
                const oldest = lightboxWarmCache.keys().next().value;
                if (oldest) lightboxWarmCache.delete(oldest);
            }
            return promise;
        }

        function progressiveLightboxImage(element, imageId, previewUrl, highUrl, onHighReady) {
            if (!element) return;
            const preview = String(previewUrl || highUrl || '');
            const high = String(highUrl || preview);
            element.dataset.imageId = String(imageId || '');
            element.dataset.fallback = preview;
            element.decoding = 'async';
            element.loading = 'eager';
            element.fetchPriority = 'high';
            // Paint the light preview first; upgrade to the 2000px image in
            // the background so opening the lightbox never waits on Drive.
            if (element.getAttribute('src') !== preview) element.src = preview;
            if (!high || high === preview) return;
            let upgradeStarted = false;
            const startUpgrade = () => {
                if (upgradeStarted) return;
                upgradeStarted = true;
                const run = () => warmLightboxImage(high, 'low').then(ready => {
                    if (!ready || element.dataset.imageId !== String(imageId || '')) return;
                    onHighReady?.();
                    if (element.getAttribute('src') !== high) element.src = high;
                });
                if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 900 });
                else window.setTimeout(run, 24);
            };
            // Let the preview win the first round-trip on mobile. The larger
            // request begins only after the preview has painted (or failed).
            element.addEventListener('load', startUpgrade, { once: true });
            element.addEventListener('error', startUpgrade, { once: true });
            if (element.complete && element.naturalWidth > 0) startUpgrade();
        }

        function getShareUrl() {
            return state.publicSlug ? `${ONLINE_SERVER}/a/${encodeURIComponent(state.publicSlug)}` : `${ONLINE_SERVER}/client.html?id=${encodeURIComponent(folderId || '')}`;
        }

        async function downloadCheckImage() {
            if (state.viewMode !== 'check' && state.galleryType !== 'party') return;
            const current = getCurrentImage();
            if (!current?.id) return;
            const method = await saveImageForVisitor(current);
            if (method === 'share') {
                setMessage('Đã mở bảng chia sẻ. Hãy chọn “Lưu hình ảnh” để đưa ảnh vào thư viện Ảnh trên iPhone.', 'success');
            }
        }

        function isMobileDownloadDevice() {
            return window.matchMedia?.('(pointer: coarse)').matches
                || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
        }

        async function saveImageForVisitor(image) {
            if (!image?.id) return;
            const url = getProtectedDriveImageUrl(image, 'original', true);
            if (!url) return;
            const fileName = image.fullName || 'dk-workflow-image';
            // iOS does not allow a website to write directly into Photos. On
            // supported Safari versions, hand the downloaded File to the
            // native share sheet so the visitor can choose “Save Image”.
            // Browsers without file sharing keep the normal download path.
            if (isMobileDownloadDevice() && typeof navigator.share === 'function') {
                try {
                    const response = await fetch(url, { credentials: 'include' });
                    if (response.ok) {
                        const blob = await response.blob();
                        const type = blob.type || 'image/jpeg';
                        const file = new File([blob], fileName, { type });
                        const canShareFiles = typeof navigator.canShare !== 'function'
                            || navigator.canShare({ files: [file] });
                        if (canShareFiles) {
                            await navigator.share({ files: [file], title: 'DK Workflow', text: 'Lưu ảnh vào thư viện Ảnh' });
                            return 'share';
                        }
                    }
                } catch (error) {
                    // Closing the share sheet is not a download failure. For
                    // other errors, fall through to the browser download.
                    if (error?.name === 'AbortError') return 'cancelled';
                }
            }
            const link = document.createElement('a');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            return 'download';
        }

        async function triggerPartyDownload(image) {
            return saveImageForVisitor(image);
        }

        function updatePartyDownloadQueue() {
            const queue = elements.partyDownloadQueue;
            if (!queue) return;
            const remaining = Math.max(0, partyDownloadQueue.length - partyDownloadIndex);
            if (!remaining) {
                queue.classList.remove('visible');
                return;
            }
            queue.classList.add('visible');
            elements.partyDownloadQueueText.textContent = isMobileDownloadDevice()
                ? `Đã lưu ${partyDownloadIndex}/${partyDownloadQueue.length}. Nhấn từng lần để mở bảng chia sẻ và chọn “Lưu hình ảnh”.`
                : `Đã tải ${partyDownloadIndex}/${partyDownloadQueue.length}.`;
            elements.partyDownloadNextBtn.textContent = isMobileDownloadDevice()
                ? `Lưu ảnh tiếp theo (${partyDownloadIndex + 1}/${partyDownloadQueue.length})`
                : `Tải ảnh tiếp theo (${partyDownloadIndex + 1}/${partyDownloadQueue.length})`;
            elements.partyDownloadNextBtn.disabled = partyDownloadBusy;
        }

        async function downloadNextPartyImage() {
            if (state.galleryType !== 'party' || partyDownloadBusy || partyDownloadIndex >= partyDownloadQueue.length) return;
            partyDownloadBusy = true;
            updatePartyDownloadQueue();
            try {
                const method = await triggerPartyDownload(partyDownloadQueue[partyDownloadIndex]);
                if (method === 'cancelled') return;
                partyDownloadIndex += 1;
            } finally {
                partyDownloadBusy = false;
                updatePartyDownloadQueue();
            }
        }

        function cancelPartyDownloadQueue() {
            partyDownloadQueue = [];
            partyDownloadIndex = 0;
            updatePartyDownloadQueue();
        }

        function downloadPartySelection() {
            if (state.galleryType !== 'party') return;
            const selected = state.originalImages.filter(image => partySelected.has(image.fullName));
            if (!selected.length) { setMessage('Hãy tích chọn ít nhất một ảnh để tải xuống.', 'error'); return; }
            if (isMobileDownloadDevice()) {
                partyDownloadQueue = selected;
                partyDownloadIndex = 0;
                setMessage(`Đã chuẩn bị ${selected.length} ảnh. Mỗi lần nhấn sẽ mở bảng chia sẻ để bạn chọn “Lưu hình ảnh”.`, 'success');
                updatePartyDownloadQueue();
                // The first share still starts inside the user's tap.
                downloadNextPartyImage();
                return;
            }
            selected.forEach((image, index) => window.setTimeout(() => triggerPartyDownload(image), index * 180));
            setMessage(`Đang mở ${selected.length} lượt tải ảnh…`, 'success');
        }

        function renderBranding() {
            // Selection/CHECK/FINAL albums use the Studio identity. Gallery /
            // PSC uses the configured gallery name as its public title.
            const publicName = state.galleryType === 'party'
                ? (state.displayName || state.clientName || 'Finder')
                : (state.studioName || 'Finder');
            elements.brandTitle.textContent = String(publicName).trim().toUpperCase() || 'FINDER';
            elements.albumStatusPill.textContent = state.workflowStatus === 'completed' ? '● Hoàn thành' : state.checkNeedsRevision ? '● Khách yêu cầu sửa thêm' : state.checkReady ? '● CHECK ' + (state.checkVersion || 1) + ' · chờ kiểm tra' : state.isFinalized ? '● Đã chốt lựa chọn' : '● Đang mở lựa chọn';
            elements.checkReadyBanner.textContent = state.workflowStatus === 'completed'
                ? '✅ Ảnh đã chỉnh sửa xong, hãy lưu ảnh sớm nhé. Link ảnh sẽ tự hủy trong vòng 60 ngày.'
                : state.checkNeedsRevision
                ? '🛠️ Studio đang chờ xử lý ghi chú sửa thêm của bạn.'
                : '✅ Ảnh đã chỉnh sửa xong · CHECK ' + (state.checkVersion || 1) + '. Bạn đang xem bản mới nhất.';
        }

        function selectedCount() {
            return state.originalImages.filter(item => item.selected).length;
        }

        function setViewMode(mode, preserveFileName = '') {
            const nextMode = mode === 'check' && state.checkReady ? 'check' : 'original';
            const currentName = preserveFileName || getCurrentImage()?.fullName || '';
            state.viewMode = nextMode;
            state.compareEnabled = false;
            if (nextMode !== 'original') state.activeAiGroupIndex = null;
            state.images = nextMode === 'check' ? state.checkImages : state.originalImages;
            const nextIndex = currentName ? state.images.findIndex(item => item.fullName === currentName) : -1;
            state.currentIndex = nextIndex >= 0 ? nextIndex : 0;
            // Use the scheduled path for every original-view transition so
            // mobile receives the same progress indicator and background
            // grouping behavior as the initial album load.
            if (nextMode === 'original') scheduleAiGroups();
            else state.aiGroups = [];
            render();
        }

        function closeSelectionReopenModal() {
            elements.selectionReopenModal.classList.remove('open');
            elements.selectionReopenModal.setAttribute('aria-hidden', 'true');
        }

        function showSelectionReopenModal() {
            elements.selectionReopenModal.classList.add('open');
            elements.selectionReopenModal.setAttribute('aria-hidden', 'false');
        }

        function naturalImageCompare(a, b) {
            return String(a?.fullName || a?.shortName || '').localeCompare(String(b?.fullName || b?.shortName || ''), undefined, { numeric: true, sensitivity: 'base' });
        }

        function setGallerySection(sectionId) {
            state.activeGallerySection = sectionId || 'all';
            const base = state.viewMode === 'check' ? state.checkImages : state.originalImages;
            state.images = state.galleryType === 'party' && state.activeGallerySection !== 'all'
                ? base.filter(image => String(image.gallerySectionId || '') === String(state.activeGallerySection))
                : base.slice();
            state.images.sort(naturalImageCompare);
            state.currentIndex = 0;
            render();
        }

        function renderGallerySections() {
            const nav = elements.gallerySectionsNav;
            if (!nav) return;
            const sections = state.galleryType === 'party' ? state.gallerySections : [];
            nav.innerHTML = '';
            if (sections.length < 2) { nav.style.display = 'none'; if (elements.partyGalleryActions) elements.partyGalleryActions.style.display = state.galleryType === 'party' ? 'flex' : 'none'; return; }
            nav.style.display = 'flex';
            const orderedSections = sections.slice().sort((a, b) => {
                const rank = value => { const name = String(value?.name || '').toLowerCase(); return name.includes('vu quy') ? 0 : name.includes('thành hôn') || name.includes('thanh hon') ? 1 : 2; };
                return rank(a) - rank(b) || naturalImageCompare({ fullName: a?.name }, { fullName: b?.name });
            });
            orderedSections.forEach(section => {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'gallery-section-btn';
                const count = state.originalImages.filter(image => String(image.gallerySectionId || '') === String(section.id || section.driveFolderId)).length;
                button.textContent = `${section.name || 'Ngày'} (${count}${state.pagesPending ? '+' : ''})`;
                button.classList.toggle('active', String(state.activeGallerySection) === String(section.id || section.driveFolderId));
                button.onclick = () => setGallerySection(section.id || section.driveFolderId);
                nav.appendChild(button);
            });
            const all = document.createElement('button'); all.type = 'button'; all.className = 'gallery-section-btn'; all.textContent = `Tất cả (${state.originalImages.length}${state.pagesPending ? '+' : ''})`;
            all.classList.toggle('active', state.activeGallerySection === 'all'); all.onclick = () => setGallerySection('all'); nav.appendChild(all);
            if (elements.partyGalleryActions) elements.partyGalleryActions.style.display = state.galleryType === 'party' ? 'flex' : 'none';
        }

        const visualSignatureCache = new WeakMap();
        async function getVisualSignature(image) {
            if (visualSignatureCache.has(image)) return visualSignatureCache.get(image);
            const source = image.thumbnail || image.preview || '';
            if (!source) return null;
            const signature = await new Promise((resolve, reject) => {
                const sourceImage = new Image();
                sourceImage.crossOrigin = 'anonymous';
                sourceImage.decoding = 'async';
                sourceImage.onload = () => {
                    try {
                        const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 12;
                        const context = canvas.getContext('2d', { willReadFrequently: true });
                        context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                        const values = []; let total = 0;
                        for (let i = 0; i < pixels.length; i += 4) { const gray = pixels[i] * .299 + pixels[i + 1] * .587 + pixels[i + 2] * .114; values.push(gray); total += gray; }
                        const mean = total / Math.max(1, values.length);
                        const scale = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length)) || 1;
                        resolve(values.map(value => (value - mean) / scale));
                    } catch (error) { reject(error); }
                };
                sourceImage.onerror = reject;
                sourceImage.src = source;
            });
            visualSignatureCache.set(image, signature);
            return signature;
        }

        function signatureDistance(a, b) {
            if (!a || !b || a.length !== b.length) return 1;
            let total = 0;
            for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
            return total / a.length;
        }

        // Gom theo thứ tự tên + độ tương đồng thumbnail. Tên file chỉ dùng để
        // giữ đúng thứ tự burst; quyết định ảnh có cùng cụm hay không dựa trên
        // đặc trưng hình ảnh, tránh việc cả album bị đề xuất hàng loạt.
        function getAiWorkerCount(total) {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const effectiveType = String(connection?.effectiveType || '').toLowerCase();
            if (connection?.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') {
                return Math.min(2, total);
            }
            const coarsePointer = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
            const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
            return Math.min(coarsePointer || mobileUserAgent ? 4 : 8, total);
        }

        function getAiProgressLabel() {
            const total = Math.max(
                Number(state.aiAnalysisTotal) || 0,
                Number(state.aiGroupSourceCount) || 0,
                state.originalImages.length
            );
            if (!total) return '';
            const processed = Math.min(total, Math.max(0, Number(state.aiAnalysisProcessed) || 0));
            return `${processed}/${total} ảnh`;
        }

        function updateAiAnalysisProgress() {
            updateAiLoadingNotice();
            if (!elements.aiPicksDescription || !state.aiAnalysisPending) return;
            const progress = getAiProgressLabel();
            const progressSuffix = progress ? ` · ${progress}` : '';
            const found = state.aiGroups.length ? `Đã tìm ${state.aiGroups.length} cụm` : 'Đang chuẩn bị phân tích';
            elements.aiPicksDescription.textContent = `${found} · đang phân tích trong nền${progressSuffix}…`;
        }

        function isAiGroupingAllowed() {
            // Gallery/PSC and FINAL are delivery-only views. They must never
            // spend CPU/network time running the selection-only culling pass.
            return state.galleryType !== 'party'
                && !state.isFinalized
                && state.workflowStatus !== 'completed';
        }

        async function buildAiGroups(sourceImages = state.images, runId = aiGroupingRunId) {
            if (!isAiGroupingAllowed()) {
                state.aiGroups = [];
                state.aiGroupsComplete = false;
                state.aiAnalysisPending = false;
                return;
            }
            const sourceCount = sourceImages.length;
            const isComplete = !state.pagesPending && !state.pageLoading && sourceCount >= state.originalImages.length;
            const isActive = () => runId === aiGroupingRunId;
            state.aiGroupSourceCount = sourceCount;
            state.aiAnalysisTotal = Math.max(sourceCount, state.originalImages.length);
            state.aiAnalysisProcessed = 0;
            state.aiGroupsComplete = isComplete;
            if (state.viewMode !== 'original' || !sourceImages.length) { state.aiGroups = []; state.aiGroupsComplete = false; return; }
            const ordered = sourceImages.slice().sort(naturalImageCompare);
            if (sourceImages === state.images) state.images = ordered;
            const groupCacheKey = 'finder-ai-groups:' + folderId + ':' + ordered.map(item => item.fullName + ':' + (item.thumbnail || '')).join('|');
            try {
                const cachedGroups = JSON.parse(localStorage.getItem(groupCacheKey) || 'null');
                if (Array.isArray(cachedGroups)) {
                    const byName = new Map(ordered.map((image, index) => [image.fullName, { image, index }]));
                    state.aiGroups = cachedGroups.map(group => group.map(name => byName.get(name)).filter(Boolean)).filter(group => group.length >= 2);
                    state.aiAnalysisProcessed = ordered.length;
                    updateAiAnalysisProgress();
                    if (state.aiGroups.length || isComplete) return;
                }
            } catch (_) {}
            const indexed = ordered.map((image, index) => ({ image, index }));
            // A cache miss with no usable groups falls through to a fresh
            // signature pass; restart its counter instead of retaining the
            // cached list length as if those images had just been analysed.
            state.aiAnalysisProcessed = 0;
            updateAiAnalysisProgress();
            const signatures = new Map();
            let nextSignatureIndex = 0;
            const signatureWorker = async () => {
                while (true) {
                    const index = nextSignatureIndex++;
                    if (index >= indexed.length) return;
                    const item = indexed[index];
                    try { signatures.set(item.image, await getVisualSignature(item.image)); } catch (_) { signatures.set(item.image, null); }
                    if (isActive()) {
                        state.aiAnalysisProcessed = Math.min(indexed.length, state.aiAnalysisProcessed + 1);
                        updateAiAnalysisProgress();
                    }
                    // Yield less often than before; the work is already
                    // bounded to tiny 12x12 signatures and the larger worker
                    // pool makes mobile albums finish noticeably sooner.
                    if (index % 8 === 7) await new Promise(resolve => {
                        if ('requestIdleCallback' in window) window.requestIdleCallback(resolve, { timeout: 40 });
                        else window.setTimeout(resolve, 8);
                    });
                }
            };
            await Promise.all(Array.from({ length: getAiWorkerCount(indexed.length) }, signatureWorker));
            if (!isActive()) return;
            const groups = []; let group = [];
            for (let index = 0; index < indexed.length; index++) {
                const item = indexed[index];
                const previous = group[group.length - 1];
                const distance = previous ? signatureDistance(signatures.get(previous.image), signatures.get(item.image)) : 1;
                const sameVisualBurst = Boolean(previous && distance <= 0.34);
                if (group.length && !sameVisualBurst) {
                    if (group.length >= 2) groups.push(group);
                    group = [];
                }
                group.push(item);
            }
            if (group.length >= 2) groups.push(group);
            state.aiGroups = groups;
            state.aiAnalysisProcessed = indexed.length;
            updateAiAnalysisProgress();
            try { localStorage.setItem(groupCacheKey, JSON.stringify(groups.map(group => group.map(item => item.image.fullName)))); } catch (_) {}
        }

        // AI grouping is helpful but not required to start browsing. Delay it
        // until the first image and the initial controls have had a chance to
        // paint, so a large album does not compete with the first thumbnails.
        function scheduleAiGroups(sourceImages = state.images) {
            window.clearTimeout(aiGroupingTimer);
            const runId = ++aiGroupingRunId;
            if (!isAiGroupingAllowed()) {
                state.aiAnalysisPending = false;
                state.aiAnalysisProcessed = 0;
                state.aiAnalysisTotal = 0;
                state.aiGroupSourceCount = 0;
                state.aiGroupsComplete = false;
                state.aiGroups = [];
                state.aiGroupsExpanded = false;
                state.galleryExpanded = true;
                renderAiPicks();
                updateAlbumLoadingOverlay();
                return;
            }
            state.aiAnalysisPending = Boolean(sourceImages.length && state.viewMode === 'original');
            state.aiGroupSourceCount = sourceImages.length;
            state.aiAnalysisTotal = Math.max(sourceImages.length, state.originalImages.length);
            state.aiAnalysisProcessed = 0;
            state.aiGroupsComplete = !state.pagesPending && !state.pageLoading && sourceImages.length >= state.originalImages.length;
            if (!state.aiAccordionUserInteracted) {
                state.aiGroupsExpanded = false;
                state.galleryExpanded = true;
            }
            updateAlbumLoadingOverlay();
            // Paint the compact “đang phân tích” state immediately instead of
            // leaving a blank section until the first worker finishes.
            if (elements.aiPicksPanel) renderAiPicks();
            updateAiAnalysisProgress();
            const run = () => {
                aiGroupingTimer = null;
                if (state.viewMode !== 'original' || !sourceImages.length) {
                    if (runId === aiGroupingRunId) {
                        state.aiAnalysisPending = false;
                        state.aiAnalysisProcessed = state.aiAnalysisTotal;
                        updateAlbumLoadingOverlay();
                    }
                    return;
                }
                buildAiGroups(sourceImages)
                    .then(() => render())
                    .catch(() => {})
                    .finally(() => {
                        if (runId === aiGroupingRunId) {
                            state.aiAnalysisPending = false;
                            state.aiAnalysisProcessed = state.aiAnalysisTotal;
                            if (!state.aiAccordionUserInteracted) {
                                if (state.aiGroupsComplete && state.aiGroups.length) {
                                    state.aiGroupsExpanded = true;
                                    state.galleryExpanded = false;
                                } else {
                                    state.aiGroupsExpanded = false;
                                    state.galleryExpanded = true;
                                }
                            }
                            updateAlbumLoadingOverlay();
                            render();
                        }
                    });
            };
            if ('requestIdleCallback' in window) {
                window.requestIdleCallback(run, { timeout: 2200 });
            } else {
                aiGroupingTimer = window.setTimeout(run, 1400);
            }
        }

        function getAiWarmWindow() {
            const start = Math.max(0, state.currentIndex - 12);
            return state.originalImages.slice(start, start + 36);
        }

        function setAiGroupsExpanded(expanded) {
            state.aiAccordionUserInteracted = true;
            state.aiGroupsExpanded = !!expanded;
            const available = state.viewMode === 'original' && !state.isFinalized
                && (state.aiGroups.length > 0 || state.aiAnalysisPending || state.pagesPending);
            if (available) state.galleryExpanded = !state.aiGroupsExpanded;
            render();
        }

        function setGalleryExpanded(expanded) {
            state.aiAccordionUserInteracted = true;
            state.galleryExpanded = !!expanded;
            const available = state.viewMode === 'original' && !state.isFinalized
                && (state.aiGroups.length > 0 || state.aiAnalysisPending || state.pagesPending);
            if (available) state.aiGroupsExpanded = !state.galleryExpanded;
            render();
        }

        function renderAiPicks() {
            aiGroupObserver?.disconnect();
            const isOriginal = state.viewMode === 'original' && !state.isFinalized;
            const stillWorking = isOriginal && (state.aiAnalysisPending || state.pagesPending || state.pageLoading || (!state.aiGroupsComplete && state.originalImages.length > 0));
            const available = isOriginal && (state.aiGroups.length > 0 || stillWorking);
            if (!available) {
                elements.aiPicksPanel.style.display = 'none';
                const galleryOpen = state.galleryExpanded !== false;
                elements.galleryPanel?.classList.toggle('is-collapsed', !galleryOpen);
                elements.galleryToggle?.setAttribute('aria-checked', galleryOpen ? 'true' : 'false');
                if (elements.galleryToggleLabel) elements.galleryToggleLabel.textContent = galleryOpen ? 'Đang mở' : 'Đã thu gọn';
                return;
            }
            elements.aiPicksPanel.style.display = '';
            elements.aiPicksCount.textContent = state.aiGroups.length
                ? `${state.aiGroups.length}${state.aiGroupsComplete ? '' : '+'} cụm`
                : 'Đang phân tích…';
            if (elements.aiPicksDescription) {
                elements.aiPicksDescription.textContent = stillWorking
                    ? `${state.aiGroups.length ? `Đã tìm ${state.aiGroups.length} cụm` : 'Đang chuẩn bị phân tích'} · đang phân tích trong nền${getAiProgressLabel() ? ` · ${getAiProgressLabel()}` : ''}…`
                    : 'Các ảnh gần giống nhau được gom để bạn xem nhanh';
            }
            const expanded = state.aiGroupsExpanded !== false;
            // The two panels intentionally behave like an accordion: opening
            // one automatically collapses the other to keep mobile browsing
            // focused and prevent duplicate grids in a large album.
            state.galleryExpanded = !expanded;
            elements.aiPicksPanel.classList.toggle('is-collapsed', !expanded);
            elements.aiPicksGrid.hidden = !expanded;
            elements.aiPicksToggle?.setAttribute('aria-checked', expanded ? 'true' : 'false');
            if (elements.aiPicksToggleLabel) elements.aiPicksToggleLabel.textContent = expanded ? 'Đang mở' : 'Đã thu gọn';
            elements.galleryPanel?.classList.toggle('is-collapsed', state.galleryExpanded === false);
            elements.galleryToggle?.setAttribute('aria-checked', state.galleryExpanded ? 'true' : 'false');
            if (elements.galleryToggleLabel) elements.galleryToggleLabel.textContent = state.galleryExpanded ? 'Đang mở' : 'Đã thu gọn';
            elements.aiPicksGrid.innerHTML = '';
            if (!expanded) return;
            state.aiGroups.forEach((group, groupIndex) => {
                const first = group[0];
                const card = document.createElement('button'); card.className = 'ai-pick-card'; card.type = 'button';
                const image = document.createElement('img'); image.loading = 'lazy'; image.decoding = 'async'; image.dataset.src = first.image.thumbnail || first.image.originalUrl || ''; image.alt = 'Nhóm ảnh tương tự ' + (groupIndex + 1);
                const label = document.createElement('span'); label.className = 'ai-pick-label'; label.textContent = 'Cụm ' + (groupIndex + 1) + ' · ' + group.length + ' ảnh tương tự';
                card.append(image, label); card.addEventListener('click', () => {
                    state.activeAiGroupIndex = groupIndex;
                    const nextIndex = state.images.findIndex(item => item.fullName === first.image.fullName);
                    state.currentIndex = nextIndex >= 0 ? nextIndex : first.index;
                    render();
                    openLightbox();
                });
                elements.aiPicksGrid.appendChild(card);
                if (aiGroupObserver) aiGroupObserver.observe(card);
                else hydrateAiGroupCard(card);
            });
        }

        function currentAiGroupContext() {
            if (state.viewMode !== 'original' || !state.aiGroups.length) return null;
            const current = getCurrentImage();
            if (!current) return null;
            const matchesCurrent = group => group.some(item => item.image.fullName === current.fullName);
            let groupIndex = Number.isInteger(state.activeAiGroupIndex) && state.aiGroups[state.activeAiGroupIndex] && matchesCurrent(state.aiGroups[state.activeAiGroupIndex])
                ? state.activeAiGroupIndex
                : state.aiGroups.findIndex(matchesCurrent);
            if (groupIndex < 0) return null;
            const group = state.aiGroups[groupIndex];
            const position = group.findIndex(item => item.image.fullName === current.fullName);
            if (position < 0) return null;
            state.activeAiGroupIndex = groupIndex;
            return { groupIndex, group, position };
        }

        function setImageByGroupItem(item) {
            const nextIndex = state.images.findIndex(image => image.fullName === item?.image?.fullName);
            if (nextIndex < 0) return false;
            state.currentIndex = nextIndex;
            return true;
        }

        function navigateAiGroup(direction) {
            const context = currentAiGroupContext();
            if (!context) return false;
            let targetGroupIndex = context.groupIndex;
            let targetPosition = context.position + direction;
            if (targetPosition >= context.group.length) {
                targetGroupIndex += 1;
                targetPosition = 0;
            } else if (targetPosition < 0) {
                targetGroupIndex -= 1;
                targetPosition = targetGroupIndex >= 0 ? state.aiGroups[targetGroupIndex].length - 1 : -1;
            }
            if (targetGroupIndex < 0 || targetGroupIndex >= state.aiGroups.length) return true;
            const targetGroup = state.aiGroups[targetGroupIndex];
            if (!targetGroup || !targetGroup[targetPosition] || !setImageByGroupItem(targetGroup[targetPosition])) return true;
            state.activeAiGroupIndex = targetGroupIndex;
            return true;
        }

        function createThumbEntry(img, index, isPartyGallery) {
            const thumbBtn = document.createElement('button');
            thumbBtn.className = 'thumb-btn';
            thumbBtn.type = 'button';
            thumbBtn.dataset.imageIndex = String(index);
            thumbBtn.setAttribute('aria-label', `Mở ảnh ${index + 1} ở chế độ toàn màn hình`);
            thumbBtn.title = 'Mở ảnh lớn';
            if (index === state.currentIndex) thumbBtn.classList.add('active');
            if (img.selected) thumbBtn.classList.add('selected');
            const thumbImg = document.createElement('img');
            thumbImg.loading = 'lazy';
            thumbImg.decoding = 'async';
            thumbImg.dataset.src = img.thumbnail || img.originalUrl || '';
            thumbImg.alt = img.shortName || img.fullName || 'Ảnh';
            thumbBtn.appendChild(thumbImg);
            if (isPartyGallery) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox'; checkbox.checked = partySelected.has(img.fullName); checkbox.title = 'Chọn ảnh tải xuống';
                checkbox.style.cssText = 'position:absolute;top:7px;left:7px;width:19px;height:19px;z-index:2;accent-color:#22c55e;';
                checkbox.addEventListener('click', event => event.stopPropagation());
                checkbox.addEventListener('change', () => { checkbox.checked ? partySelected.add(img.fullName) : partySelected.delete(img.fullName); updatePartyActions(); });
                thumbBtn.appendChild(checkbox);
            }
            thumbBtn.onclick = () => {
                state.currentIndex = index;
                render();
                // A thumbnail is an image entry, not only a navigation item.
                // Open the same full-screen lightbox used by the main viewer
                // on every client mode (selection, CHECK, FINAL and gallery).
                openLightbox();
            };
            return { button: thumbBtn, image: thumbImg };
        }

        function syncThumbStates() {
            thumbButtonsByIndex.forEach((button, index) => {
                const image = state.images[index];
                if (!image) return;
                button.classList.toggle('active', index === state.currentIndex);
                button.classList.toggle('selected', !!image.selected);
                const checkbox = button.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = partySelected.has(image.fullName);
            });
        }

        function renderThumbStrip(galleryEntries, isPartyGallery) {
            // Keep the Drive filename order in the strip. Moving selected
            // images to the front made the visible order differ from the
            // lightbox and caused the first image to appear to change.
            // `state.images` is kept naturally sorted whenever pages/sections
            // change, so avoid another O(n log n) sort on every navigation.
            const ordered = galleryEntries;
            const firstId = ordered[0]?.img?.id || ordered[0]?.img?.fullName || '';
            const lastId = ordered[ordered.length - 1]?.img?.id || ordered[ordered.length - 1]?.img?.fullName || '';
            const nextKey = `${isPartyGallery ? 'party' : 'selection'}:${state.viewMode}:${state.activeGallerySection}:${ordered.length}:${firstId}:${lastId}`;
            // Navigating or toggling a note should only update classes on the
            // existing buttons. Rebuilding hundreds of DOM nodes on every
            // render was a major source of jank on mobile.
            if (nextKey === thumbRenderKey && thumbButtonsByIndex.size === ordered.length) {
                syncThumbStates();
                return;
            }
            thumbRenderKey = nextKey;
            const version = ++thumbRenderVersion;
            thumbButtonsByIndex.clear();
            thumbObserver?.disconnect();
            elements.thumbStrip.innerHTML = '';
            let cursor = 0;
            const appendBatch = () => {
                if (version !== thumbRenderVersion) return;
                const fragment = document.createDocumentFragment();
                const images = [];
                const end = Math.min(cursor + 48, ordered.length);
                for (; cursor < end; cursor += 1) {
                    const entry = createThumbEntry(ordered[cursor].img, ordered[cursor].index, isPartyGallery);
                    fragment.appendChild(entry.button);
                    thumbButtonsByIndex.set(ordered[cursor].index, entry.button);
                    images.push(entry.image);
                }
                elements.thumbStrip.appendChild(fragment);
                if (thumbObserver) images.forEach(image => thumbObserver.observe(image));
                else images.forEach(image => {
                    image.src = image.dataset.src || '';
                    image.addEventListener('load', () => image.classList.add('is-ready'), { once: true });
                });
                if (cursor < ordered.length) {
                    const schedule = 'requestIdleCallback' in window
                        ? callback => window.requestIdleCallback(callback, { timeout: 180 })
                        : callback => window.setTimeout(callback, 0);
                    schedule(appendBatch);
                }
            };
            appendBatch();
        }


        function updateCheckBannerVisibility() {
            const lightboxOpen = elements.imageLightbox.classList.contains('open');
            const isCompleted = state.workflowStatus === 'completed';
            const remaining = state.expiresAt ? Math.max(0, Date.parse(state.expiresAt) - Date.now()) : 0;
            const days = remaining ? Math.ceil(remaining / 86400000) : (Number(state.expiresDays) || 60);
            if (isCompleted) {
                const notice = days > 0
                    ? `✅ Hãy tải ảnh trong vòng ${days} ngày nhé · link ảnh sẽ tự hủy sau thời hạn này.`
                    : '✅ Album đã hoàn thành.';
                elements.finalizedBanner.textContent = notice;
                elements.checkReadyBanner.textContent = notice;
            }
            elements.checkReadyBanner.classList.toggle('visible', !lightboxOpen && (isCompleted ? state.viewMode === 'check' : state.checkReady && state.viewMode === 'check'));
            elements.finalizedBanner.classList.toggle('visible', !lightboxOpen && isCompleted && state.viewMode === 'original');
        }

        function canSelect(image) {
            if (!image || image.selected || state.maxSelections <= 0) return true;
            if (selectedCount() < state.maxSelections) return true;
            setMessage(`⚠️ Album này chỉ cho phép chọn tối đa ${state.maxSelections} ảnh.`, 'error');
            return false;
        }

        function render() {
            if (!state.images.length) {
                elements.mainImage.src = '';
                elements.photoName.textContent = 'Không có ảnh nào';
                elements.photoIndexLabel.textContent = '0/0';
                elements.selectedCountLabel.textContent = `0/${state.maxSelections > 0 ? state.maxSelections : state.originalImages.length}`;
                elements.photoStatusBadge.textContent = 'Trống';
                elements.selectionList.innerHTML = '<div class="empty-state">Không có ảnh nào để hiển thị.</div>';
                elements.thumbStrip.innerHTML = '';
                return;
            }

            const current = getCurrentImage();
            current.viewed = true;
            renderBranding();
            const isCheckView = state.viewMode === 'check';
            const isPartyGallery = state.galleryType === 'party';
            const isFinalView = state.workflowStatus === 'completed' || isPartyGallery;
            if (isFinalView) state.compareEnabled = false;
            const canEditSelection = !isCheckView && !state.isFinalized && !isPartyGallery;
            const canEditNote = !state.workflowStatus || state.workflowStatus !== 'completed' ? (isCheckView || canEditSelection) : false;
            // Paint the small Drive thumbnail first, then replace it with the
            // larger preview in the background. This makes the first image
            // visible quickly on slower mobile networks without changing the
            // high-resolution lightbox flow.
            const imageId = String(current.id || current.fullName);
            const thumbnailUrl = current.thumbnail || current.preview || current.originalUrl || '';
            const previewUrl = current.preview || current.thumbnail || current.originalUrl || '';
            const imageChanged = elements.mainImage.dataset.imageId !== imageId;
            if (imageChanged) {
                elements.viewerShell.classList.add('loading');
                elements.mainImage.dataset.imageId = imageId;
                elements.mainImage.dataset.previewUrl = previewUrl;
            }
            elements.mainImage.decoding = 'async';
            elements.mainImage.loading = 'eager';
            elements.mainImage.fetchPriority = 'high';
            elements.mainImage.alt = current.shortName || current.fullName || 'Ảnh';
            if (imageChanged) {
                elements.mainImage.src = thumbnailUrl;
            }
            if (previewUrl && previewUrl !== thumbnailUrl && elements.mainImage.dataset.previewLoaded !== imageId) {
                elements.mainImage.dataset.previewLoaded = imageId;
                const preview = new Image();
                preview.decoding = 'async';
                preview.fetchPriority = 'high';
                preview.onload = () => {
                    if (elements.mainImage.dataset.imageId === imageId && elements.mainImage.dataset.previewUrl === previewUrl) {
                        elements.mainImage.src = previewUrl;
                    }
                };
                preview.src = previewUrl;
            }
            elements.photoName.textContent = current.shortName || current.fullName || 'Ảnh';
            elements.photoIndexLabel.textContent = `${state.currentIndex + 1}/${state.images.length}`;
            const currentSelectedCount = selectedCount();
            // Gộp số lượng đã chọn và hạn mức ngay trên nút hiện có để khách
            // luôn thấy dạng `đã chọn/tối đa` mà không cần một ô thống kê riêng.
            const selectionLimit = state.maxSelections > 0 ? state.maxSelections : state.originalImages.length;
            elements.selectedCountLabel.textContent = `${currentSelectedCount}/${selectionLimit}`;
            elements.photoStatusBadge.textContent = isCheckView ? 'Ảnh chỉnh sửa' : (current.selected ? 'Đã chọn' : 'Chưa chọn');
            elements.photoStatusBadge.style.background = current.selected ? 'rgba(34,197,94,0.18)' : 'rgba(59,130,246,0.18)';
            elements.photoStatusBadge.style.color = current.selected ? '#bbf7d0' : '#bfdbfe';
            // Các gallery chỉ xem (FINAL và gallery tiệc) không hiển thị nhãn
            // chọn/trạng thái hay hướng dẫn của luồng lựa ảnh.
            elements.albumStatusPill.style.display = isFinalView ? 'none' : '';
            elements.photoStatusBadge.style.display = isFinalView ? 'none' : '';
            elements.swipeHint.style.display = isFinalView ? 'none' : '';
            elements.statusMessage.style.display = isFinalView && !elements.statusMessage.classList.contains('error') ? 'none' : '';
            const galleryEntries = state.images.map((img, index) => ({ img, index }));
            elements.galleryCount.textContent = `${state.images.length}${state.pagesPending ? '+' : ''} ảnh`;
            renderGallerySections();
            elements.reviewModeBar.classList.toggle('visible', state.checkReady && !isPartyGallery);
            elements.checkAcceptBtn.style.display = state.checkReady && state.viewMode === 'check' && !state.checkNeedsRevision && state.workflowStatus !== 'completed' ? '' : 'none';
            elements.checkModeBtn.classList.toggle('active', isCheckView);
            elements.originalModeBtn.classList.toggle('active', !isCheckView);
            elements.contentGrid.classList.toggle('check-view', isCheckView);
            elements.selectedImagesSection.style.display = isCheckView || isPartyGallery ? 'none' : '';
            elements.jumpToSelected.style.display = isCheckView || isPartyGallery ? 'none' : '';
            updateCheckBannerVisibility();
            elements.selectBtn.classList.toggle('active', !!current.selected);
            elements.selectBtn.classList.toggle('btn-select-selected', !!current.selected);
            elements.selectBtn.classList.toggle('btn-outline', !current.selected);
            elements.selectBtn.textContent = current.selected ? '✅ Đã chọn' : '☑️ Chọn ảnh';
            elements.lightboxSelectBtn.textContent = current.selected ? '✓ Đã chọn' : '✓ Chọn';
            elements.lightboxSelectBtn.style.background = current.selected ? 'rgba(22,163,74,.92)' : 'rgba(15,23,42,.75)';
            elements.noteInput.value = current.note || '';
            [elements.selectBtn, elements.confirmAllBtn]
                .forEach(element => { element.disabled = !canEditSelection || savingFiles.has(current.fullName); });
            [elements.saveNoteBtn, elements.noteInput]
                .forEach(element => { element.disabled = !canEditNote || savingFiles.has(current.fullName); });
            elements.noteSection.style.display = canEditNote ? 'block' : 'none';
            elements.imageActionRow.style.display = (canEditSelection || isCheckView) ? '' : 'none';
            elements.selectBtn.style.display = canEditSelection ? '' : 'none';
            elements.saveNoteBtn.style.display = canEditNote ? '' : 'none';
            elements.confirmAllBtn.style.display = canEditSelection ? '' : 'none';
            elements.lightboxSelectBtn.disabled = !canEditSelection || savingFiles.has(current.fullName);
            elements.lightboxNoteBtn.disabled = !canEditNote || savingFiles.has(current.fullName);
            elements.lightboxSelectBtn.style.display = canEditSelection ? '' : 'none';
            elements.lightboxNoteBtn.style.display = canEditNote ? '' : 'none';
            elements.lightboxDownloadBtn.style.display = isCheckView || isPartyGallery ? '' : 'none';
            elements.lightboxDownloadBtn.textContent = isMobileDownloadDevice() ? '💾 Lưu vào Ảnh' : '⬇️ Tải ảnh';
            if (elements.partyGalleryActions) elements.partyGalleryActions.style.display = isPartyGallery ? 'flex' : 'none';
            if (isFinalView) {
                elements.compareToggleBtn.style.display = 'none';
                elements.compareStage.classList.remove('visible');
            }

            renderThumbStrip(galleryEntries, isPartyGallery);

            renderSelectionList();
            preloadNearbyImages();
            renderAiPicks();
            updatePartyActions();
            scheduleClientViewStatePersist();
        }

        function updatePartyActions() {
            if (!elements.partyGalleryActions || state.galleryType !== 'party') return;
            const visible = state.images.filter(image => image);
            const allSelected = visible.length > 0 && visible.every(image => partySelected.has(image.fullName));
            const waitingForPages = state.pagesPending || state.pageLoading;
            if (elements.partySelectAllBtn) {
                elements.partySelectAllBtn.textContent = waitingForPages ? 'Đang tải danh sách…' : (allSelected ? 'Bỏ chọn phần này' : 'Chọn tất cả phần này');
                elements.partySelectAllBtn.disabled = waitingForPages;
            }
            if (elements.partyDownloadBtn) {
                elements.partyDownloadBtn.textContent = waitingForPages ? 'Đang chuẩn bị ảnh…' : `⬇️ Tải ảnh đã chọn (${partySelected.size})`;
                elements.partyDownloadBtn.disabled = waitingForPages;
            }
        }

        function warmNearbyImage(url, priority = 'low') {
            if (!url || nearbyImageWarmCache.has(url)) return;
            nearbyImageWarmCache.add(url);
            if (nearbyImageWarmCache.size > NEARBY_IMAGE_WARM_CACHE_LIMIT) {
                const oldest = nearbyImageWarmCache.values().next().value;
                if (oldest) nearbyImageWarmCache.delete(oldest);
            }
            const preload = new Image();
            preload.decoding = 'async';
            preload.fetchPriority = priority;
            preload.src = url;
        }

        function preloadNearbyImages() {
            [-1, 1, 2].forEach(offset => {
                const image = state.images[(state.currentIndex + offset + state.images.length) % state.images.length];
                if (!image) return;
                // Warm only the next full preview. The other neighbors use a
                // small thumbnail and are upgraded when actually opened.
                const source = offset === 1
                    ? (image.preview || image.thumbnail || '')
                    : (image.thumbnail || image.preview || '');
                warmNearbyImage(source, offset === 1 ? 'high' : 'low');
            });
        }

        function preloadLightboxNeighbors() {
            if (!state.images.length) return;
            [1, -1].forEach(offset => {
                const image = state.images[(state.currentIndex + offset + state.images.length) % state.images.length];
                if (!image) return;
                const preview = image.preview || image.thumbnail || image.originalUrl || '';
                // Warm only the lightweight preview. The full lightbox image
                // is fetched after the visitor opens that specific image.
                warmLightboxImage(preview, offset === 1 ? 'high' : 'low');
            });
        }

        function renderSelectionList() {
            const selectedNames = new Set(state.originalImages.filter(item => item.selected).map(item => item.fullName));
            const selectedImages = (state.viewMode === 'check' ? state.checkImages : state.originalImages)
                .filter(item => selectedNames.has(item.fullName));
            elements.selectionList.innerHTML = '';

            if (!selectedImages.length) {
                elements.selectionList.innerHTML = '<div class="empty-state">Chưa có ảnh nào được chọn. Nhấn “Chọn ảnh” để lưu lựa chọn.</div>';
                return;
            }

            selectedImages.forEach(item => {
                const card = document.createElement('div');
                card.className = 'selection-item';
                const thumb = document.createElement('img');
                thumb.loading = 'lazy'; thumb.decoding = 'async'; thumb.src = item.thumbnail || item.preview || item.originalUrl || '';
                thumb.alt = item.shortName || item.fullName || 'Ảnh đã chọn';
                const info = document.createElement('div');
                info.innerHTML = `<strong>${escapeHtml(item.shortName || item.fullName || 'Ảnh')}</strong><span>${escapeHtml(item.note || 'Không có ghi chú')}</span>`;
                card.append(thumb, info);
                card.addEventListener('click', () => {
                    setViewMode(state.viewMode, item.fullName);
                    openLightbox();
                });
                elements.selectionList.appendChild(card);
            });
        }

        function nextImage() {
            if (!state.images.length) return;
            if (elements.imageLightbox.classList.contains('open') && navigateAiGroup(1)) {
                render();
                updateLightboxContent();
                return;
            }
            state.currentIndex = (state.currentIndex + 1) % state.images.length;
            render();
            if (state.pagesPending && state.viewMode === 'original') scheduleAiGroups(getAiWarmWindow());
            if (elements.imageLightbox.classList.contains('open')) updateLightboxContent();
        }

        function prevImage() {
            if (!state.images.length) return;
            if (elements.imageLightbox.classList.contains('open') && navigateAiGroup(-1)) {
                render();
                updateLightboxContent();
                return;
            }
            state.currentIndex = (state.currentIndex - 1 + state.images.length) % state.images.length;
            render();
            if (state.pagesPending && state.viewMode === 'original') scheduleAiGroups(getAiWarmWindow());
            if (elements.imageLightbox.classList.contains('open')) updateLightboxContent();
        }

        function applyZoom() {
            zoomScale = Math.max(1, Math.min(4, zoomScale));
            if (zoomScale === 1) { panX = 0; panY = 0; }
            clampPan();
            elements.lightboxImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
            elements.lightboxImage.classList.toggle('zoomed', zoomScale > 1);
        }

        function clampPan() {
            if (zoomScale <= 1) return;
            const rect = elements.lightboxImage.getBoundingClientRect();
            // getBoundingClientRect đã bao gồm zoom, nên chia ngược để lấy kích thước gốc.
            const baseWidth = rect.width / zoomScale;
            const baseHeight = rect.height / zoomScale;
            const maxX = Math.max(0, (baseWidth * zoomScale - window.innerWidth) / 2);
            const maxY = Math.max(0, (baseHeight * zoomScale - window.innerHeight) / 2);
            panX = Math.max(-maxX, Math.min(maxX, panX));
            panY = Math.max(-maxY, Math.min(maxY, panY));
        }

        function setZoomOrigin(clientX, clientY) {
            const rect = elements.lightboxImage.getBoundingClientRect();
            if (!rect.width || !rect.height) { elements.lightboxImage.style.transformOrigin = 'center'; return; }
            const x = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            const y = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
            elements.lightboxImage.style.transformOrigin = `${x}% ${y}%`;
        }

        function normalizeCompareName(name = '') {
            return String(name).toLowerCase()
                .replace(/\.[^.]+$/, '')
                .replace(/(?:[_ -](?:edited?|check|final|retouched|edit))$/i, '')
                .replace(/(?:[_ -]\d{1,3})$/i, '')
                .replace(/[^a-z0-9]+/g, '');
        }

        function findOriginalForCheck(checkImage) {
            if (!checkImage) return null;
            const exact = state.originalImages.find(item => item.fullName === checkImage.fullName);
            if (exact) return exact;
            const normalized = normalizeCompareName(checkImage.fullName);
            const byNormalizedName = state.originalImages.find(item => normalizeCompareName(item.fullName) === normalized);
            if (byNormalizedName) return byNormalizedName;
            const fallbackIndex = state.checkImages.indexOf(checkImage);
            return fallbackIndex >= 0 && state.originalImages.length === state.checkImages.length ? state.originalImages[fallbackIndex] : null;
        }

        function updateCompareSlider() {
            const value = Number(elements.compareRange.value || 50);
            elements.compareClip.style.width = `${value}%`;
            elements.compareDivider.style.left = `${value}%`;
        }

        function updateLightboxContent() {
            const current = getCurrentImage();
            if (!current) return;
            const groupContext = currentAiGroupContext();
            if (elements.lightboxGroupContext) {
                if (groupContext) {
                    elements.lightboxGroupContext.hidden = false;
                    elements.lightboxGroupContext.textContent = `Cụm ${groupContext.groupIndex + 1} · ${groupContext.position + 1}/${groupContext.group.length} ảnh`;
                } else {
                    elements.lightboxGroupContext.hidden = true;
                    elements.lightboxGroupContext.textContent = '';
                }
            }
            const highResolutionUrl = current.lightbox || current.originalUrl || current.preview || current.thumbnail || '';
            const previewResolutionUrl = current.preview || current.thumbnail || current.originalUrl || highResolutionUrl;
            const compareOriginal = state.viewMode === 'check' ? findOriginalForCheck(current) : null;
            const isFinalView = state.workflowStatus === 'completed' || state.galleryType === 'party';
            const canCompare = !isFinalView && Boolean(compareOriginal && (compareOriginal.lightbox || compareOriginal.originalUrl));
            const showCompare = canCompare && state.compareEnabled;
            elements.compareToggleBtn.style.display = canCompare ? '' : 'none';
            elements.compareToggleBtn.textContent = showCompare ? '🖼️ Ảnh đơn' : '↔ So sánh';
            elements.compareStage.classList.toggle('visible', showCompare);
            elements.lightboxImage.style.display = showCompare ? 'none' : '';
            elements.lightboxLoading.classList.remove('hidden');
            elements.lightboxLoading.textContent = showCompare ? 'Đang tải ảnh xem trước để so sánh…' : 'Đang tải ảnh xem trước…';
            if (showCompare) {
                const compareRect = elements.compareStage.getBoundingClientRect();
                elements.compareStage.style.setProperty('--compare-stage-width', `${compareRect.width}px`);
                elements.compareStage.style.setProperty('--compare-stage-height', `${compareRect.height}px`);
                const originalHighUrl = compareOriginal.lightbox || compareOriginal.originalUrl || compareOriginal.preview || compareOriginal.thumbnail || '';
                const originalPreviewUrl = compareOriginal.preview || compareOriginal.thumbnail || originalHighUrl;
                progressiveLightboxImage(elements.compareOriginalImage, `original:${compareOriginal.id || compareOriginal.fullName}`, originalPreviewUrl, originalHighUrl);
                progressiveLightboxImage(elements.compareCheckImage, `check:${current.id || current.fullName}`, previewResolutionUrl, highResolutionUrl);
                elements.compareRange.value = '50';
                updateCompareSlider();
            } else {
                progressiveLightboxImage(elements.lightboxImage, current.id || current.fullName, previewResolutionUrl, highResolutionUrl);
            }
            zoomScale = 1;
            panX = 0; panY = 0; panPointer = null;
            elements.lightboxImage.style.transformOrigin = 'center';
            applyZoom();
            preloadLightboxNeighbors();
        }

        function openLightbox() {
            if (!getCurrentImage()) return;
            state.compareEnabled = false;
            elements.imageLightbox.classList.add('open');
            elements.imageLightbox.setAttribute('aria-hidden', 'false');
            updateCheckBannerVisibility();
            updateLightboxContent();
        }

        function closeLightbox() {
            elements.imageLightbox.classList.remove('open');
            elements.imageLightbox.setAttribute('aria-hidden', 'true');
            activePointers.clear();
            panPointer = null;
            updateCheckBannerVisibility();
        }

        function renderRobotMessage(message) {
            elements.robotMessage.replaceChildren();
            if (message && typeof message === 'object' && message.href) {
                elements.robotMessage.append(document.createTextNode(message.prefix || ''));
                const link = document.createElement('a');
                link.href = message.href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = message.linkText || 'Đình Kiệt';
                link.setAttribute('aria-label', 'Liên hệ Đình Kiệt trên Facebook');
                elements.robotMessage.append(link);
                if (message.suffix) elements.robotMessage.append(document.createTextNode(message.suffix));
                return;
            }
            elements.robotMessage.textContent = String(message || '');
        }

        function showRobotStatus(message, repeat = false) {
            window.clearTimeout(robotMessageTimeout);
            window.clearInterval(robotMessageInterval);
            renderRobotMessage(message);
            const flash = () => {
                elements.helpRobot.classList.add('visible');
                robotMessageTimeout = window.setTimeout(() => elements.helpRobot.classList.remove('visible'), 5000);
            };
            flash();
            if (repeat) robotMessageInterval = window.setInterval(flash, 10000);
        }

        function visibleImageTotal() {
            const count = state.originalImages.length || state.images.length;
            return `${count}${state.pagesPending || state.pageLoading ? '+' : ''}`;
        }

        function robotContextGreeting() {
            if (!state.images.length) return 'Hiện album chưa có ảnh để xem.';
            if (state.cacheHydrated && (state.pagesPending || state.pageLoading)) return `⚡ Em đã mở nhanh ${state.originalImages.length} ảnh đã lưu. Phần còn lại đang tải nền, mình vẫn có thể xem ảnh ngay nhé.`;
            if (state.galleryType === 'party') return `Gallery tiệc đã sẵn sàng với ${state.gallerySections.length || 1} ngày/đợt ảnh và ${visibleImageTotal()} ảnh. Bạn có thể chuyển mục để xem từng phần.`;
            if (state.workflowStatus === 'completed') return 'Album đã hoàn tất. Bạn có thể xem và lưu các ảnh chất lượng cao.';
            if (state.checkNeedsRevision) return '🛠️ Studio đã nhận ghi chú của bạn và đang chờ xử lý chỉnh sửa tiếp.';
            if (state.checkReady) return `Album đã có ${state.checkImages.length} ảnh chỉnh sửa. Bạn có thể mở ảnh để kiểm tra.`;
            if (state.isFinalized) return `Đã ghi nhận ${selectedCount()} ảnh bạn chọn. Studio sẽ xử lý theo các ghi chú trong album.`;
            if (state.maxSelections > 0 && selectedCount() >= state.maxSelections) return `✅ Bạn đã chọn đủ ${state.maxSelections} ảnh. Hãy kiểm tra lại rồi xác nhận khi sẵn sàng.`;
            if (selectedCount() > 0) return `👍 Bạn đã chọn ${selectedCount()}${state.maxSelections > 0 ? `/${state.maxSelections}` : ''} ảnh. Bạn có thể tiếp tục xem và ghi chú trước khi chốt.`;
            if (state.maxSelections > 0) return `Album có ${visibleImageTotal()} ảnh. Bạn có thể chọn tối đa ${state.maxSelections} ảnh; mình sẽ cập nhật số đã chọn ngay trên nút.`;
            return `Album có ${visibleImageTotal()} ảnh. Hãy mở ảnh bạn quan tâm để xem và gửi lựa chọn cho studio.`;
        }

        function robotContextPrompts() {
            const selected = selectedCount();
            const loadingHint = state.pagesPending || state.pageLoading
                ? `Em đang tải tiếp phần ảnh còn lại ở nền (${visibleImageTotal()} ảnh đã nhận).`
                : 'Toàn bộ danh sách ảnh đã sẵn sàng.';
            if (state.galleryType === 'party') return [
                `Gallery có ${state.gallerySections.length || 1} ngày/đợt ảnh và ${visibleImageTotal()} ảnh để xem.`,
                'Bạn có thể chuyển tab ngày ở phía trên thư viện ảnh.',
                `Bạn đang xem ${state.currentIndex + 1}/${state.images.length} ảnh trong mục hiện tại.`,
                loadingHint
            ];
            if (state.workflowStatus === 'completed') return [
                'Ảnh đã hoàn tất, bạn có thể lưu lại ngay.',
                `Bạn đang xem ${state.currentIndex + 1}/${state.images.length} ảnh hoàn thiện.`,
                'Nếu cần hỗ trợ thêm, hãy liên hệ studio qua thông tin trên trang.'
            ];
            if (state.checkNeedsRevision) return [
                'Studio đã nhận ghi chú và sẽ xử lý yêu cầu chỉnh sửa tiếp.',
                'Bạn có thể xem lại từng ảnh CHECK để bổ sung ghi chú nếu cần.',
                `Hiện có ${state.checkImages.length} ảnh trong bản CHECK mới nhất.`
            ];
            if (state.checkReady) return [
                'Bạn có thể mở ảnh để kiểm tra bản chỉnh sửa.',
                'Nếu cần sửa thêm, hãy mở ảnh rồi gửi ghi chú cho studio.',
                `Bạn đang xem ${state.currentIndex + 1}/${state.images.length} ảnh chỉnh sửa.`,
                loadingHint
            ];
            if (state.isFinalized) return [
                'Lựa chọn đã được khóa; bạn vẫn có thể xem lại ảnh.',
                `Album đã chốt ${selected} ảnh.`,
                'Studio sẽ dựa trên lựa chọn và ghi chú để xử lý ảnh.'
            ];
            return [
                `Bạn đã chọn ${selected}${state.maxSelections > 0 ? `/${state.maxSelections}` : ''} ảnh trong album.`,
                'Bạn có thể mở ảnh lớn để kiểm tra trước khi chốt.',
                'Nếu cần chỉnh sửa riêng, hãy ghi chú ngay trên ảnh đó.',
                loadingHint
            ];
        }

        function nextRobotPrompt() {
            const shouldContact = robotPromptIndex >= 3
                && robotPromptIndex % 4 === 3
                && Date.now() - robotContactShownAt >= ROBOT_CONTACT_COOLDOWN_MS;
            if (shouldContact) {
                robotContactShownAt = Date.now();
                return ROBOT_CONTACT_PROMPT;
            }
            const prompts = robotContextPrompts();
            return prompts[robotPromptIndex % prompts.length];
        }

        function scheduleRobotAssistant() {
            window.clearTimeout(robotIdleTimer);
            robotIdleTimer = window.setTimeout(() => {
                if (elements.imageLightbox.classList.contains('open')) { scheduleRobotAssistant(); return; }
                showRobotStatus(nextRobotPrompt());
                robotPromptIndex += 1;
                scheduleRobotAssistant();
            }, 22000);
        }

        function resetRobotAssistant() { scheduleRobotAssistant(); }

        function attachSwipe() {
            let startX = 0;
            elements.viewerShell.addEventListener('touchstart', (event) => {
                startX = event.touches[0].clientX;
            }, { passive: true });

            elements.viewerShell.addEventListener('touchend', (event) => {
                const delta = event.changedTouches[0].clientX - startX;
                if (Math.abs(delta) > 60) {
                    if (delta < 0) nextImage();
                    else prevImage();
                }
            }, { passive: true });
        }

        elements.mainImage.addEventListener('click', openLightbox);
        elements.mainImage.addEventListener('load', () => elements.viewerShell.classList.remove('loading'));
        elements.mainImage.addEventListener('error', () => { elements.viewerShell.classList.remove('loading'); setMessage('Không thể tải ảnh xem trước. Hãy thử ảnh khác.', 'error'); });
        elements.lightboxImage.addEventListener('error', () => {
            elements.lightboxLoading.classList.add('hidden');
            const fallback = elements.lightboxImage.dataset.fallback;
            if (fallback && elements.lightboxImage.src !== fallback) elements.lightboxImage.src = fallback;
        });
        elements.lightboxImage.addEventListener('load', () => elements.lightboxLoading.classList.add('hidden'));
        elements.compareOriginalImage.addEventListener('load', () => elements.lightboxLoading.classList.add('hidden'));
        elements.compareCheckImage.addEventListener('load', () => elements.lightboxLoading.classList.add('hidden'));
        elements.compareRange.addEventListener('input', updateCompareSlider);
        elements.compareRange.addEventListener('pointerdown', event => event.stopPropagation());
        elements.compareToggleBtn.addEventListener('click', event => {
            event.stopPropagation();
            state.compareEnabled = !state.compareEnabled;
            updateLightboxContent();
        });
        elements.lightboxDownloadBtn.addEventListener('click', downloadCheckImage);
        elements.driveAccessBtn?.addEventListener('click', openDriveFolder);
        elements.closeLightboxBtn.addEventListener('click', closeLightbox);
        elements.imageLightbox.addEventListener('click', event => {
            if (Date.now() < suppressLightboxCloseUntil) { event.preventDefault(); return; }
            if (event.target === elements.imageLightbox && Date.now() - lastLightboxSwipeAt >= 350) closeLightbox();
        });
        elements.imageLightbox.addEventListener('dblclick', event => { setZoomOrigin(event.clientX, event.clientY); zoomScale = zoomScale > 1 ? 1 : 2.5; applyZoom(); });
        elements.imageLightbox.addEventListener('wheel', event => {
            event.preventDefault();
            setZoomOrigin(event.clientX, event.clientY);
            zoomScale += event.deltaY < 0 ? 0.25 : -0.25;
            applyZoom();
        }, { passive: false });
        elements.imageLightbox.addEventListener('pointerdown', event => {
            if (event.target.closest('button')) return;
            elements.imageLightbox.setPointerCapture?.(event.pointerId);
            activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (activePointers.size === 1) {
                lightboxPointerMoved = false;
                lightboxPanStart = { x: event.clientX, y: event.clientY };
            }
            if (activePointers.size === 1 && zoomScale <= 1) {
                lightboxSwipeStart = { pointerId: event.pointerId, x: event.clientX };
            }
            if (activePointers.size === 2) {
                panPointer = null;
                lightboxSwipeStart = null;
                const [a, b] = [...activePointers.values()];
                pinchStartDistance = Math.hypot(a.x - b.x, a.y - b.y);
                pinchStartScale = zoomScale;
                setZoomOrigin((a.x + b.x) / 2, (a.y + b.y) / 2);
            } else if (zoomScale > 1) {
                panPointer = event.pointerId;
                elements.lightboxImage.classList.add('panning');
            }
        });
        elements.imageLightbox.addEventListener('pointermove', event => {
            if (!activePointers.has(event.pointerId)) return;
            const previous = activePointers.get(event.pointerId);
            activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (lightboxPanStart && (Math.abs(event.clientX - lightboxPanStart.x) > 3 || Math.abs(event.clientY - lightboxPanStart.y) > 3)) lightboxPointerMoved = true;
            if (activePointers.size === 2 && pinchStartDistance) {
                const [a, b] = [...activePointers.values()];
                zoomScale = pinchStartScale * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStartDistance);
                applyZoom();
            } else if (panPointer === event.pointerId && zoomScale > 1) {
                panX += event.clientX - previous.x;
                panY += event.clientY - previous.y;
                applyZoom();
            }
        });
        ['pointerup', 'pointercancel'].forEach(type => elements.imageLightbox.addEventListener(type, event => {
            if (type === 'pointerup' && lightboxPointerMoved) {
                lastLightboxSwipeAt = Date.now();
                suppressLightboxCloseUntil = Date.now() + 450;
            }
            if (type === 'pointerup' && lightboxSwipeStart?.pointerId === event.pointerId) {
                const startX = lightboxSwipeStart.x;
                lightboxSwipeStart = null;
                const delta = event.clientX - startX;
                if (zoomScale <= 1 && Math.abs(delta) >= 55) {
                    lastLightboxSwipeAt = Date.now();
                    delta < 0 ? nextImage() : prevImage();
                }
            } else if (type === 'pointercancel' && lightboxSwipeStart?.pointerId === event.pointerId) {
                lightboxSwipeStart = null;
            }
            activePointers.delete(event.pointerId);
            if (activePointers.size < 2) pinchStartDistance = 0;
            if (panPointer === event.pointerId) panPointer = null;
            if (!panPointer) elements.lightboxImage.classList.remove('panning');
            if (activePointers.size === 0) { lightboxPointerMoved = false; lightboxPanStart = null; }
        }));
        // Fallback cho WebView/mobile cũ không phát Pointer Events. Trên trình
        // duyệt hiện đại pointerup đã xử lý, mốc thời gian tránh chuyển ảnh 2 lần.
        let lightboxSwipeStartX = null;
        elements.imageLightbox.addEventListener('touchstart', event => {
            if (zoomScale > 1 || event.touches.length !== 1 || event.target.closest('button')) return;
            lightboxSwipeStartX = event.touches[0].clientX;
        }, { passive: true });
        elements.imageLightbox.addEventListener('touchend', event => {
            if (lightboxSwipeStartX === null || zoomScale > 1) return;
            const delta = event.changedTouches[0].clientX - lightboxSwipeStartX;
            lightboxSwipeStartX = null;
            if (Date.now() - lastLightboxSwipeAt < 300) return;
            if (Math.abs(delta) >= 55) {
                lastLightboxSwipeAt = Date.now();
                delta < 0 ? nextImage() : prevImage();
            }
        }, { passive: true });
        elements.lightboxSelectBtn.addEventListener('click', async () => {
            const current = getCurrentImage();
            if (!current || (!current.selected && !canSelect(current))) return;
            if (savingFiles.has(current.fullName)) return;
            savingFiles.add(current.fullName);
            elements.lightboxSelectBtn.disabled = true;
            current.selected = !current.selected;
            render();
            setMessage(current.selected ? '✅ Đã chọn ảnh này.' : '🗑️ Đã bỏ chọn ảnh này.', 'success');
            showRobotStatus(current.selected ? '✅ Mình đã ghi nhận ảnh này vào danh sách của bạn.' : 'Đã bỏ ảnh khỏi danh sách lựa chọn.');
            try {
                await saveCurrentSelection();
            } catch (error) {
                current.selected = !current.selected;
                render();
                setMessage(`❌ ${error.message}`, 'error');
            } finally {
                savingFiles.delete(current.fullName);
                elements.lightboxSelectBtn.disabled = false;
            }
        });
        elements.copyShareBtn.addEventListener('click', async () => {
            const shareUrl = getShareUrl();
            try { await navigator.clipboard.writeText(shareUrl); }
            catch (_) { const input = document.createElement('input'); input.value = shareUrl; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove(); }
            elements.copyShareBtn.textContent = 'Đã sao chép ✓';
            window.setTimeout(() => { elements.copyShareBtn.textContent = '🔗 Sao chép link'; }, 1800);
        });
        elements.showQrBtn.addEventListener('click', () => {
            const shareUrl = getShareUrl();
            elements.qrImage.src = `https://quickchart.io/qr?size=220&text=${encodeURIComponent(shareUrl)}`;
            elements.qrLinkText.textContent = shareUrl;
            elements.qrModal.classList.add('open'); elements.qrModal.setAttribute('aria-hidden', 'false');
        });
        function closeQr() { elements.qrModal.classList.remove('open'); elements.qrModal.setAttribute('aria-hidden', 'true'); }
        elements.closeQrBtn.addEventListener('click', closeQr);
        elements.qrModal.addEventListener('click', event => { if (event.target === elements.qrModal) closeQr(); });
        elements.reopenOriginalBtn.addEventListener('click', () => { closeSelectionReopenModal(); setViewMode('original'); });
        elements.reopenCheckBtn.addEventListener('click', () => { closeSelectionReopenModal(); setViewMode('check'); });
        elements.selectionReopenModal.addEventListener('click', event => { if (event.target === elements.selectionReopenModal) closeSelectionReopenModal(); });
        elements.lightboxNoteBtn.addEventListener('click', () => {
            const current = getCurrentImage();
            if (!current) return;
            elements.quickNoteInput.value = current.note || '';
            elements.quickNoteModal.classList.add('open');
            elements.quickNoteModal.setAttribute('aria-hidden', 'false');
            elements.quickNoteInput.focus();
        });
        elements.quickNoteCancelBtn.addEventListener('click', () => elements.quickNoteModal.classList.remove('open'));
        elements.quickNoteSaveBtn.addEventListener('click', async () => {
            const current = getCurrentImage();
            if (!current) return;
            current.note = elements.quickNoteInput.value.trim();
            try {
                await saveCurrentSelection(current.note);
                elements.quickNoteModal.classList.remove('open');
                render();
                setMessage('📝 Đã lưu ghi chú cho ảnh này.', 'success');
                showRobotStatus('📝 Mình đã gửi ghi chú này cho studio.');
            } catch (error) { setMessage(`❌ ${error.message}`, 'error'); }
        });
        elements.quickNoteModal.addEventListener('click', event => { if (event.target === elements.quickNoteModal) elements.quickNoteModal.classList.remove('open'); });
        elements.robotButton.addEventListener('click', () => { elements.helpRobot.classList.toggle('visible'); resetRobotAssistant(); });
        ['pointerdown', 'touchstart', 'keydown'].forEach(type => document.addEventListener(type, resetRobotAssistant, { passive: true }));
        window.setTimeout(() => elements.helpRobot.classList.remove('visible'), 6000);

        async function saveCurrentSelection(noteOverride) {
            const current = getCurrentImage();
            if (!current) return;

            current.note = noteOverride === undefined ? elements.noteInput.value.trim() : String(noteOverride).trim();
            if (state.viewMode === 'check') {
                const checkResponse = await fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}/check-note`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: current.fullName, note: current.note })
                });
                const checkData = await checkResponse.json().catch(() => ({}));
                if (!checkResponse.ok || !checkData.success) throw new Error(checkData.error || `Máy chủ trả về lỗi ${checkResponse.status}.`);
                if (current.note) { state.checkNeedsRevision = true; render(); }
                return checkData;
            }
            const response = await fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}/toggle-like`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileName: current.fullName,
                    isLiked: !!current.selected,
                    note: current.note
                })
            });
            let data;
            try {
                data = await response.json();
            } catch (error) {
                throw new Error(`Máy chủ trả về lỗi ${response.status}. Vui lòng thử lại hoặc kiểm tra Vercel Logs.`);
            }
            if (!response.ok) {
                const requestId = response.headers.get('x-request-id') || data.requestId;
                throw new Error(`${data.error || `Máy chủ trả về lỗi ${response.status}.`}${requestId ? ` [requestId=${requestId}]` : ''}`);
            }
            if (!data.success) throw new Error(data.error || 'Không thể lưu dữ liệu');
            return data;
        }

        async function fetchWithRetry(url, options, attempts = 2) {
            let lastError;
            for (let attempt = 0; attempt < attempts; attempt++) {
                try {
                    const response = await fetch(url, { credentials: 'include', ...(options || {}) });
                    if (response.status < 500 || attempt === attempts - 1) return response;
                } catch (error) {
                    lastError = error;
                    if (attempt === attempts - 1) throw error;
                }
                await new Promise(resolve => window.setTimeout(resolve, 180 * (attempt + 1)));
            }
            throw lastError || new Error('Không thể kết nối máy chủ.');
        }

        function applyAlbumSettings(settings = {}, isFinalized = state.isFinalized, gallerySections = []) {
            state.galleryType = settings.galleryType || (settings.partyGallery ? 'party' : 'selection');
            state.gallerySections = Array.isArray(gallerySections) && gallerySections.length
                ? gallerySections
                : (Array.isArray(settings.gallerySections) ? settings.gallerySections : []);
            const firstGalleryFolder = state.gallerySections.find(section => section?.driveFolderId || section?.id);
            state.driveFolderId = String(
                settings.driveFolderId
                || settings.originalFolderId
                || firstGalleryFolder?.driveFolderId
                || firstGalleryFolder?.id
                || ''
            ).trim();
            if (!state.activeGallerySection) state.activeGallerySection = 'all';
            state.expiresDays = Number(settings.expiresDays) || 60;
            state.isFinalized = !!isFinalized || state.galleryType === 'party';
            state.maxSelections = Number(settings.maxSelections) || 0;
            state.checkFolderId = settings.checkFolderId || null;
            state.checkUpdatedAt = settings.checkUpdatedAt || null;
            state.checkVersion = Number(settings.checkVersion) || 1;
            state.checkNeedsRevision = Boolean(settings.checkNeedsRevision);
            state.workflowStatus = settings.workflowStatus || (state.checkReady ? 'check_pending' : 'selection_open');
            state.expiresAt = settings.expiresAt || null;
            state.selectionReopenedAt = settings.selectionReopenedAt || null;
            state.selectionConfirmedAt = settings.selectionConfirmedAt || null;
            state.publicSlug = settings.publicSlug || state.publicSlug;
            const configuredStudio = String(settings.studioName || '').trim();
            state.studioName = configuredStudio && !/^(finder|finder studio)$/i.test(configuredStudio)
                ? configuredStudio.toUpperCase()
                : 'FINDER';
            state.displayName = String(settings.displayName || state.studioName || 'Finder').trim() || 'Finder';
            updateDriveAccessButton();
        }

        function updateDriveAccessButton() {
            const folderId = String(state.driveFolderId || '').trim();
            const available = /^[A-Za-z0-9_-]{10,}$/.test(folderId);
            if (elements.driveGalleryActions) elements.driveGalleryActions.style.display = available ? 'flex' : 'none';
            if (elements.driveAccessBtn) elements.driveAccessBtn.disabled = !available;
        }

        function openDriveFolder() {
            const folderId = String(state.driveFolderId || '').trim();
            if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId)) {
                setMessage('Album này chưa có đường dẫn Google Drive để mở.', 'error');
                return;
            }
            const url = `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}?usp=drive_link`;
            const opened = window.open(url, '_blank', 'noopener,noreferrer');
            if (!opened) window.location.href = url;
            setMessage('Đã mở thư mục Google Drive. Nếu được yêu cầu, hãy đăng nhập tài khoản có quyền truy cập.', 'success');
        }

        function applyAlbumMetadata(data = {}) {
            state.likedList = data.liked_list || {};
            state.checkNotes = data.check_notes || {};
            applyMetadataToImages([...state.originalImages, ...state.checkImages]);
            if (data.settings) applyAlbumSettings(data.settings, data.isFinalized, data.gallerySections);
            state.checkReady = Boolean(state.checkFolderId && state.checkImages.length);
            applyClientViewState();
            finalizeClientViewState();
            writeClientBootstrapCache();
            render();
        }

        async function loadRemainingAlbumPages() {
            if (state.pageLoading || !state.pageCursor) return;
            state.pagesPending = true;
            updateAlbumLoadingOverlay();
            while (state.pageCursor) {
                state.pageLoading = true;
                updateAlbumLoadingOverlay();
                updatePartyActions();
                const params = new URLSearchParams({ paged: '1', compact: '1', limit: '24', cursor: state.pageCursor });
                const response = await fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}?${params.toString()}`, { cache: 'default' }, 3);
                const data = await readApiJson(response, 'Không thể tải thêm ảnh');
                const currentName = getCurrentImage()?.fullName || '';
                mergeAlbumImages(state.originalImages, (data.files || []).map(mapAlbumImage));
                mergeAlbumImages(state.checkImages, (data.checkFiles || []).map(mapAlbumImage));
                state.checkReady = Boolean(state.checkFolderId && state.checkImages.length);
                applyClientViewState();
                state.pageCursor = data.nextCursor || null;
                state.pageHasMore = Boolean(data.hasMore && state.pageCursor);
                state.images = state.viewMode === 'check' ? state.checkImages : state.originalImages;
                const restoredIndex = currentName ? state.images.findIndex(item => item.fullName === currentName) : -1;
                if (restoredIndex >= 0) state.currentIndex = restoredIndex;
                writeClientBootstrapCache();
                render();
                updateAlbumLoadingOverlay();
            }
            state.pageLoading = false;
            state.pagesPending = false;
            state.pageHasMore = false;
            updateAlbumLoadingOverlay();
            updatePartyActions();
            // Replace the first-page hint once every Drive page has arrived;
            // the persistent status line should never keep saying that only
            // 24 images are open after the background pagination is done.
            const loadedCount = state.originalImages.length;
            const checkSuffix = state.checkImages.length ? ` và ${state.checkImages.length} ảnh CHECK` : '';
            const loadedHint = state.workflowStatus === 'completed'
                ? 'Bạn có thể xem và lưu ảnh.'
                : state.isFinalized
                ? 'Bạn có thể xem lại ảnh đã chốt.'
                : 'Bạn có thể xem và chọn ngay.';
            setMessage(`✅ Đã tải đủ ${loadedCount} ảnh${checkSuffix}. ${loadedHint}`, 'success');
            if (state.viewMode === 'original') scheduleAiGroups(state.originalImages);
            finalizeClientViewState();
            writeClientBootstrapCache();
            render();
        }

        async function loadAlbum() {
            const cacheHydrated = hydrateClientBootstrapCache();
            state.initialLoadPending = !cacheHydrated;
            state.metadataPending = true;
            state.pagesPending = cacheHydrated;
            state.pageLoading = false;
            state.aiAnalysisPending = false;
            state.aiGroupsComplete = false;
            setAlbumLoadingVisible(!cacheHydrated);
            updateAlbumLoadingOverlay();
            if (cacheHydrated) {
                setMessage(`⚡ Đã mở nhanh ${state.originalImages.length} ảnh đã lưu; đang đồng bộ bản mới ở nền…`, 'success');
                render();
                showRobotStatus(robotContextGreeting());
            }
            if (!folderId && albumSlug) {
                try {
                    const resolveResponse = await fetch(`${ONLINE_SERVER}/api/album-by-slug/${encodeURIComponent(albumSlug)}`, { cache: 'no-store', credentials: 'include' });
                    const resolved = await readApiJson(resolveResponse, 'Không thể tìm album theo đường dẫn');
                    folderId = resolved.folderId;
                    state.publicSlug = resolved.settings?.publicSlug || albumSlug;
                    // Preserve the gallery metadata while the second request
                    // loads the Drive files. If that request fails, the page
                    // still reports the correct Gallery/PSC mode instead of
                    // falling back visually to the selection workflow.
                    if (resolved.settings?.galleryType === 'party' || resolved.settings?.partyGallery) {
                        state.galleryType = 'party';
                        state.gallerySections = Array.isArray(resolved.settings.gallerySections) ? resolved.settings.gallerySections : [];
                    }
                } catch (error) {
                    state.initialLoadPending = false;
                    state.metadataPending = false;
                    setAlbumLoadingVisible(false);
                    setMessage(`❌ ${error.message}`, 'error');
                    return;
                }
            }
            if (!folderId) {
                state.initialLoadPending = false;
                state.metadataPending = false;
                setAlbumLoadingVisible(false);
                setMessage('❌ Đường dẫn album không hợp lệ.', 'error');
                return;
            }

            try {
                const albumParams = new URLSearchParams({ paged: '1', compact: '1', limit: '24' });
                if (albumSlug) albumParams.set('slug', albumSlug);
                const albumQuery = `?${albumParams.toString()}`;
                // Images and mutable selections are fetched independently. The
                // first page can paint while likes/notes are still loading.
                state.pageLoading = true;
                updateAlbumLoadingOverlay();
                const pageResponsePromise = fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}${albumQuery}`, { cache: 'default' }, 3);
                const metadataResponsePromise = fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}/meta`, { cache: 'no-store' }, 3)
                    .catch(error => { console.warn('Album metadata request failed:', error.message); return null; })
                    .finally(() => {
                        state.metadataPending = false;
                        updateAlbumLoadingOverlay();
                    });
                const response = await pageResponsePromise;
                const data = await readApiJson(response, 'Không thể tải album');
                state.pageLoading = false;

                applyAlbumSettings(data.settings || {}, data.isFinalized, data.gallerySections);
                const freshOriginalImages = (data.files || []).map(mapAlbumImage);
                const freshCheckImages = (data.checkFiles || []).map(mapAlbumImage);
                if (cacheHydrated && state.originalImages.length) {
                    // Keep the warm bootstrap visible while the first network
                    // page arrives; merge prevents a 120→24 flicker on mobile.
                    mergeAlbumImages(state.originalImages, freshOriginalImages);
                    mergeAlbumImages(state.checkImages, freshCheckImages);
                } else {
                    state.originalImages = freshOriginalImages;
                    state.checkImages = freshCheckImages;
                    state.originalImages.sort(naturalImageCompare);
                    state.checkImages.sort(naturalImageCompare);
                }
                state.checkReady = Boolean(state.checkFolderId && state.checkImages.length);
                state.pageCursor = data.nextCursor || null;
                state.pageHasMore = Boolean(data.hasMore && state.pageCursor);
                state.pagesPending = state.pageHasMore;
                state.initialLoadPending = false;
                state.metadataPending = false;
                writeClientBootstrapCache();
                updateAlbumLoadingOverlay();
                // Older pages or an API rollout may still include metadata;
                // use it immediately, then let /meta provide the canonical
                // mutable state without delaying the first paint.
                if (data.liked_list || data.check_notes) applyAlbumMetadata(data);

                // Restore the last image/mode/section for this album. A new
                // visitor has no saved state and therefore starts at the
                // first original image as before.
                state.images = state.viewMode === 'check' && state.checkReady ? state.checkImages : state.originalImages;
                state.currentIndex = Math.min(state.currentIndex, Math.max(0, state.images.length - 1));
                applyClientViewState();
                state.aiGroups = [];
                render();
                // Chỉ chào sau khi đã nạp đầy đủ trạng thái, giới hạn chọn và
                // lựa chọn đã lưu để robot không nói sai ngữ cảnh lúc mới mở.
                showRobotStatus(robotContextGreeting());
                // Analyze only the first visible page first; the complete album
                // pass runs after the remaining Drive pages finish loading.
                if (state.viewMode === 'original') scheduleAiGroups(getAiWarmWindow());
                scheduleRobotAssistant();
                const albumReadyMessage = state.checkReady
                    ? '✅ Ảnh chỉnh sửa đã sẵn sàng. Bạn có thể chuyển sang ảnh gốc đã chọn để đối chiếu.'
                    : state.workflowStatus === 'completed'
                    ? '✅ Album đã hoàn thành. Bạn có thể xem và lưu ảnh.'
                    : state.isFinalized
                    ? (state.pagesPending
                        ? `✅ Đã mở ${state.originalImages.length} ảnh đầu tiên. Phần còn lại đang tải nền; bạn có thể xem lại ảnh đã chốt.`
                        : '✅ Album đã chốt. Bạn có thể xem lại ảnh đã chốt.')
                    : state.pagesPending
                    ? `✅ Đã mở ${state.originalImages.length} ảnh đầu tiên. Phần còn lại đang tải nền; bạn có thể xem và chọn ngay.`
                    : '✅ Đã tải album. Bạn có thể vuốt xem ảnh, chọn ảnh và ghi chú ngay bây giờ.';
                setMessage(albumReadyMessage, 'success');
                metadataResponsePromise
                    .then(response => response ? readApiJson(response, 'Không thể tải trạng thái album') : null)
                    .then(data => {
                        if (data) applyAlbumMetadata(data);
                        else finalizeClientViewState();
                    })
                    .catch(error => console.warn('Album metadata deferred load failed:', error.message));
                if (state.pageCursor) loadRemainingAlbumPages().catch(error => {
                    state.pageLoading = false;
                    state.pagesPending = false;
                    state.initialLoadPending = false;
                    state.metadataPending = false;
                    state.aiAnalysisPending = false;
                    setAlbumLoadingVisible(false);
                    setMessage(`⚠️ Đã hiển thị ảnh đầu tiên nhưng chưa tải hết thư viện: ${error.message}`, 'error');
                    updatePartyActions();
                    render();
                });
            } catch (error) {
                state.initialLoadPending = false;
                state.metadataPending = false;
                state.pagesPending = false;
                state.pageLoading = false;
                state.aiAnalysisPending = false;
                setAlbumLoadingVisible(false);
                setMessage(`❌ ${error.message || 'Không thể kết nối tới Server.'}`, 'error');
            }
        }

        async function refreshAlbumLimit() {
            try {
                const response = await fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}/settings`, { cache: 'no-store' }, 3);
                const data = await readApiJson(response, 'Không thể đồng bộ cài đặt album');
                const nextLimit = Number(data.settings?.maxSelections) || 0;
                const nextFinalized = typeof data.isFinalized === 'boolean' ? data.isFinalized : state.isFinalized;
                const nextCheckFolderId = data.settings?.checkFolderId || null;
                const nextCheckReady = Boolean(data.settings?.checkReady && nextCheckFolderId);
                const nextCheckUpdatedAt = data.settings?.checkUpdatedAt || null;
                const nextCheckVersion = Number(data.settings?.checkVersion) || state.checkVersion || 1;
                const nextCheckNeedsRevision = Boolean(data.settings?.checkNeedsRevision);
                const nextWorkflowStatus = data.settings?.workflowStatus || state.workflowStatus;
                const nextExpiresAt = data.settings?.expiresAt || state.expiresAt;
                const nextSelectionReopenedAt = data.settings?.selectionReopenedAt || null;
                const limitChanged = nextLimit !== state.maxSelections;
                const statusChanged = nextFinalized !== state.isFinalized;
                const checkChanged = nextCheckReady && (!state.checkReady || nextCheckUpdatedAt !== state.checkUpdatedAt);
                const revisionChanged = nextCheckNeedsRevision !== state.checkNeedsRevision;
                state.checkVersion = nextCheckVersion;
                state.checkNeedsRevision = nextCheckNeedsRevision;
                state.workflowStatus = nextWorkflowStatus;
                state.expiresAt = nextExpiresAt;
                const selectionWasReopened = Boolean(nextSelectionReopenedAt && state.selectionReopenedAt && nextSelectionReopenedAt !== state.selectionReopenedAt);
                state.selectionReopenedAt = nextSelectionReopenedAt || state.selectionReopenedAt;
                if (limitChanged || statusChanged) {
                    state.maxSelections = nextLimit;
                    state.isFinalized = nextFinalized;
                    render();
                    if (!nextFinalized && statusChanged) {
                        setMessage('🔓 Album đã mở lại. Các ảnh cũ vẫn được giữ nguyên, bạn có thể chọn thêm ảnh.', 'success');
                    } else if (limitChanged) {
                        setMessage(nextLimit > 0 ? `ℹ️ Giới hạn mới: ${nextLimit} ảnh. Các ảnh đã chọn vẫn được giữ nguyên.` : 'ℹ️ Album hiện không giới hạn số ảnh chọn.', 'success');
                    }
                }
                if (revisionChanged) render();
                if (checkChanged) {
                    state.checkFolderId = nextCheckFolderId;
                    state.checkUpdatedAt = nextCheckUpdatedAt;
                    await loadAlbum();
                    setMessage('✨ Ảnh chỉnh sửa đã sẵn sàng. Đang mở bản CHECK để bạn kiểm tra.', 'success');
                }
                if (selectionWasReopened) {
                    state.isFinalized = false;
                    state.viewMode = 'original';
                    state.images = state.originalImages;
                    await buildAiGroups();
                    render();
                    showSelectionReopenModal();
                    setMessage('🔓 Studio đã mở lại album để bạn bổ sung lựa chọn. Ảnh chỉnh sửa cũ vẫn có thể xem ở tab CHECK.', 'success');
                }
            } catch (error) {
                // Không làm mất trạng thái hiện tại khi mạng chập chờn; lần
                // polling kế tiếp sẽ tự đồng bộ lại và báo lỗi cụ thể nếu cần.
                console.warn('[Finder] Không đồng bộ được cài đặt album:', error.message);
            }
        }

        elements.selectBtn.addEventListener('click', async () => {
            const current = getCurrentImage();
            if (!current) return;
            if (!current.selected && !canSelect(current)) return;
            if (savingFiles.has(current.fullName)) return;
            savingFiles.add(current.fullName);
            elements.selectBtn.disabled = true;
            current.selected = !current.selected;
            render();
            setMessage(current.selected ? '✅ Đã chọn ảnh này.' : '🗑️ Đã bỏ chọn ảnh này.', 'success');
            try {
                await saveCurrentSelection(current.note);
            } catch (error) {
                current.selected = !current.selected;
                render();
                setMessage(`❌ ${error.message}`, 'error');
            } finally {
                savingFiles.delete(current.fullName);
                elements.selectBtn.disabled = false;
            }
        });

        elements.saveNoteBtn.addEventListener('click', async () => {
            const current = getCurrentImage();
            if (!current) return;
            if (savingFiles.has(current.fullName)) return;
            savingFiles.add(current.fullName);
            elements.saveNoteBtn.disabled = true;
            const previousNote = current.note;
            current.note = elements.noteInput.value.trim();
            render();
            setMessage('📝 Đang lưu ghi chú…', 'success');
            try {
                await saveCurrentSelection();
                setMessage('📝 Đã lưu ghi chú cho ảnh này.', 'success');
                showRobotStatus('📝 Mình đã gửi ghi chú này cho studio.');
            } catch (error) {
                current.note = previousNote;
                render();
                setMessage(`❌ ${error.message}`, 'error');
            } finally {
                savingFiles.delete(current.fullName);
                elements.saveNoteBtn.disabled = false;
            }
        });

        elements.confirmAllBtn.addEventListener('click', async () => {
            const selectedImages = state.images.filter(item => item.selected);
            if (!selectedImages.length) {
                setMessage('⚠️ Chưa có ảnh nào được chọn để xác nhận.', 'error');
                return;
            }
            if (!window.confirm(`Xác nhận chốt ${selectedImages.length} ảnh đã chọn? Sau khi chốt, album sẽ không thể thay đổi.`)) return;

            try {
                for (const item of selectedImages) {
                    item.note = item.note || '';
                    const response = await fetch(`${ONLINE_SERVER}/api/album/${folderId}/toggle-like`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileName: item.fullName, isLiked: true, note: item.note })
                    });
                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}));
                        const requestId = response.headers.get('x-request-id') || errorData.requestId;
                        throw new Error(`${errorData.error || 'Không thể xác nhận ảnh'}${requestId ? ` [requestId=${requestId}]` : ''}`);
                    }
                }
                const finalizeResponse = await fetch(`${ONLINE_SERVER}/api/album/${folderId}/finalize`, { method: 'POST', credentials: 'include' });
                if (!finalizeResponse.ok) {
                    const errorData = await finalizeResponse.json().catch(() => ({}));
                    const requestId = finalizeResponse.headers.get('x-request-id') || errorData.requestId;
                    throw new Error(`${errorData.error || 'Không thể chốt album'}${requestId ? ` [requestId=${requestId}]` : ''}`);
                }
                const finalizedData = await finalizeResponse.json().catch(() => ({}));
                state.isFinalized = true;
                state.workflowStatus = finalizedData.workflowStatus || 'selection_confirmed';
                state.selectionConfirmedAt = finalizedData.selectionConfirmedAt || new Date().toISOString();
                state.expiresAt = finalizedData.expiresAt || null;
                render();
                showRobotStatus('Em đã tiếp nhận, em sẽ edit ảnh sớm nhé 💙', true);
                setMessage(`✔️ Đã chốt ${selectedImages.length} ảnh đã chọn và gửi về ứng dụng.`, 'success');
            } catch (error) {
                setMessage(`❌ ${error.message}`, 'error');
            }
        });

        elements.prevBtn.addEventListener('click', prevImage);
        elements.nextBtn.addEventListener('click', nextImage);
        elements.checkModeBtn.addEventListener('click', () => setViewMode('check'));
        elements.checkAcceptBtn.addEventListener('click', async () => {
            if (!state.checkReady || state.checkNeedsRevision) return;
            if (!window.confirm('Xác nhận bạn đã hài lòng với phiên bản CHECK cuối cùng?')) return;
            elements.checkAcceptBtn.disabled = true;
            try {
                const response = await fetchWithRetry(`${ONLINE_SERVER}/api/album/${folderId}/check/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) {
                    const requestId = response.headers.get('x-request-id') || data.requestId;
                    throw new Error(`${data.error || 'Không thể xác nhận phiên bản CHECK.'}${requestId ? ` [requestId=${requestId}]` : ''}`);
                }
                state.checkNeedsRevision = false;
                state.workflowStatus = 'completed';
                state.expiresAt = data.expiresAt || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
                state.checkAcceptedAt = data.completedAt || new Date().toISOString();
                render();
                setMessage('✅ Đã xác nhận ảnh cuối cùng. Album đã hoàn thành.', 'success');
                showRobotStatus('Cảm ơn bạn đã xác nhận. Album đã hoàn thành.', true);
            } catch (error) { setMessage('❌ ' + error.message, 'error'); }
            finally { elements.checkAcceptBtn.disabled = false; }
        });
        elements.originalModeBtn.addEventListener('click', () => setViewMode('original'));
        elements.aiPicksToggle?.addEventListener('click', () => {
            setAiGroupsExpanded(state.aiGroupsExpanded === false);
        });
        elements.galleryToggle?.addEventListener('click', () => {
            setGalleryExpanded(state.galleryExpanded === false);
        });
        function jumpToSection(section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            window.setTimeout(() => section.focus({ preventScroll: true }), 350);
        }
        elements.jumpToCurrent.addEventListener('click', () => jumpToSection(elements.currentImageSection));
        elements.jumpToSelected.addEventListener('click', () => jumpToSection(elements.selectedImagesSection));
        elements.partySelectAllBtn?.addEventListener('click', () => {
            if (state.galleryType !== 'party') return;
            const visible = state.images || [];
            const allSelected = visible.length > 0 && visible.every(image => partySelected.has(image.fullName));
            visible.forEach(image => allSelected ? partySelected.delete(image.fullName) : partySelected.add(image.fullName));
            render();
            updatePartyActions();
        });
        elements.partyDownloadBtn?.addEventListener('click', downloadPartySelection);
        elements.partyDownloadNextBtn?.addEventListener('click', downloadNextPartyImage);
        elements.partyDownloadCancelBtn?.addEventListener('click', cancelPartyDownloadQueue);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && elements.imageLightbox.classList.contains('open')) return closeLightbox();
            if (event.key === 'ArrowRight') nextImage();
            if (event.key === 'ArrowLeft') prevImage();
        });

        window.addEventListener('pagehide', () => {
            window.clearTimeout(clientViewStateWriteTimer);
            persistClientViewState();
        });
        attachSwipe();
        loadAlbum();
        expiryTimer = window.setInterval(updateCheckBannerVisibility, 60000);
        // Đồng bộ trạng thái thưa hơn để không tạo hàng loạt request Vercel /
        // Firebase. Khi khách quay lại tab, kiểm tra ngay một lần.
        let albumSyncTimer = null;
        const scheduleAlbumSync = (delay = 30000) => {
            window.clearTimeout(albumSyncTimer);
            if (document.hidden) return;
            albumSyncTimer = window.setTimeout(async () => {
                await refreshAlbumLimit();
                scheduleAlbumSync(30000);
            }, delay);
        };
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) window.clearTimeout(albumSyncTimer);
            else { refreshAlbumLimit().finally(() => scheduleAlbumSync(30000)); }
        });
        scheduleAlbumSync(5000);
