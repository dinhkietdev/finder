/**
 * Control-plane API rate limiting.
 *
 * The distributed counter uses the Supabase RPC when available and falls
 * back to Upstash Redis. A short-lived in-memory bucket is kept as a local
 * safety net so development still behaves sensibly when neither store is
 * configured. This module deliberately owns no application state besides
 * those ephemeral buckets.
 */
function createRateLimitMiddleware({
    isSupabaseConfigured,
    supabaseRequest,
    logStructuredEvent,
    requireSupabaseStorage = false
}) {
    const requestBuckets = new Map();
    const metrics = {
        requests: 0,
        distributedChecks: 0,
        distributedAllowed: 0,
        distributedDenied: 0,
        memoryFallback: 0,
        storageErrors: 0,
        rateLimited: 0,
        lastRateLimitedAt: null
    };

    async function checkDistributedRateLimit(key, limit) {
        if (isSupabaseConfigured()) {
            try {
                const data = await supabaseRequest('rpc/consume_rate_limit', {
                    method: 'POST',
                    body: JSON.stringify({ p_bucket: `finder:rate:${key}`, p_limit: limit, p_window_seconds: 60 })
                });
                if (data && typeof data === 'object' && typeof data.allowed === 'boolean') return data;
            } catch (error) {
                metrics.storageErrors += 1;
                logStructuredEvent('rate_limit.storage_error', { message: error.message });
            }
        }
        const redisUrl = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
        const redisToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
        if (!redisUrl || !redisToken) return null;
        try {
            const response = await fetch(`${redisUrl}/pipeline`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify([['INCR', key], ['EXPIRE', key, 60]]),
                signal: AbortSignal.timeout(400)
            });
            if (!response.ok) return null;
            const data = await response.json();
            const count = Number(data?.[0]?.result);
            return Number.isFinite(count) ? { allowed: count <= limit, count } : null;
        } catch (_) { return null; }
    }

    const rateLimitMiddleware = async function rateLimitMiddleware(req, res, next) {
        // Image bytes are immutable public-gallery assets and are already
        // guarded by the album/file authorization in the image handler. They
        // are cached at the Vercel edge, so do not throttle gallery images.
        if (/^\/album\/[^/]+\/image\/[^/]+$/i.test(req.path)) return next();
        const key = `${req.ip || 'unknown'}:${req.path.startsWith('/auth/') ? 'auth' : 'api'}`;
        const now = Date.now();
        const limit = key.endsWith(':auth') ? 30 : 240;
        metrics.requests += 1;
        const distributed = await checkDistributedRateLimit(key, limit);
        if (distributed) {
            metrics.distributedChecks += 1;
            if (distributed.allowed) metrics.distributedAllowed += 1;
            else metrics.distributedDenied += 1;
        } else {
            metrics.memoryFallback += 1;
        }
        const remaining = distributed?.count != null ? Math.max(0, limit - Number(distributed.count)) : null;
        res.set('X-RateLimit-Limit', String(limit));
        if (remaining != null) res.set('X-RateLimit-Remaining', String(remaining));
        if (distributed && !distributed.allowed) {
            metrics.rateLimited += 1;
            metrics.lastRateLimitedAt = new Date().toISOString();
            logStructuredEvent('rate_limit.blocked', { requestId: req.requestId, scope: key.endsWith(':auth') ? 'auth' : 'api', backend: 'distributed', limit });
            res.set('Retry-After', '60');
            return res.status(429).json({ success: false, requestId: req.requestId, code: 'RATE_LIMITED', error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' });
        }
        const bucket = requestBuckets.get(key) || { start: now, count: 0 };
        if (now - bucket.start > 60_000) { bucket.start = now; bucket.count = 0; }
        bucket.count += 1;
        requestBuckets.set(key, bucket);
        res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
        if (bucket.count > limit) {
            metrics.rateLimited += 1;
            metrics.lastRateLimitedAt = new Date().toISOString();
            logStructuredEvent('rate_limit.blocked', { requestId: req.requestId, scope: key.endsWith(':auth') ? 'auth' : 'api', backend: 'memory', limit });
            res.set('Retry-After', '60');
            return res.status(429).json({ success: false, requestId: req.requestId, code: 'RATE_LIMITED', error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' });
        }
        if (requestBuckets.size > 5000) {
            for (const [entry, value] of requestBuckets) {
                if (now - value.start > 120_000) requestBuckets.delete(entry);
            }
        }
        if (requireSupabaseStorage && !isSupabaseConfigured() && req.path !== '/health' && !req.path.startsWith('/auth/')) {
            return res.status(503).json({ success: false, code: 'SUPABASE_REQUIRED', requestId: req.requestId, error: 'Máy chủ production chưa cấu hình Supabase.' });
        }
        next();
    };
    rateLimitMiddleware.getMetrics = () => ({ ...metrics });
    return rateLimitMiddleware;
}

module.exports = { createRateLimitMiddleware };
