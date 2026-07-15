const crypto = require('crypto');

const ALERT_DEDUPE_MS = 5 * 60 * 1000;

function createObservability({ persistApiAlert }) {
    const alertLastSent = new Map();

    function createRequestId() {
        return crypto.randomUUID();
    }

    function logStructuredEvent(event, data = {}) {
        const record = { at: new Date().toISOString(), event, ...data };
        // Never include Authorization headers, refresh tokens, or request bodies.
        console.log(JSON.stringify(record));
        const endpoint = String(process.env.FINDER_LOG_ENDPOINT || '').trim();
        if (!endpoint) return;
        fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(process.env.FINDER_LOG_TOKEN ? { authorization: `Bearer ${process.env.FINDER_LOG_TOKEN}` } : {}) },
            body: JSON.stringify(record),
            signal: AbortSignal.timeout(1500)
        }).catch(() => {});
    }

    function buildAlertPayload(entry) {
        const format = String(process.env.FINDER_ALERT_WEBHOOK_FORMAT || 'generic').trim().toLowerCase();
        const summary = `[Finder] ${entry.event || 'api.error'} ${entry.status || ''} ${entry.method || ''} ${entry.path || ''} requestId=${entry.requestId || 'unknown'}`.trim();
        if (format === 'discord') {
            return { content: summary, embeds: [{ title: 'Finder API alert', description: summary, color: 15158332, fields: [{ name: 'Duration', value: `${entry.durationMs || 0} ms`, inline: true }] }] };
        }
        if (format === 'slack') return { text: summary, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Finder API alert*\n${summary}` } }] };
        return { ...entry, alert: true, source: 'finder' };
    }

    function postAlertWebhook(endpoint, payload) {
        const attempt = async () => {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(1500)
            });
            if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
        };
        attempt().catch(() => setTimeout(() => attempt().catch(() => {}), 250));
    }

    function sendAlert(entry) {
        const key = `${entry.status || 'unknown'}:${entry.path || 'unknown'}`;
        const now = Date.now();
        const previous = alertLastSent.get(key) || 0;
        if (now - previous < ALERT_DEDUPE_MS) return;
        alertLastSent.set(key, now);
        if (alertLastSent.size > 2000) {
            for (const [item, sentAt] of alertLastSent) if (now - sentAt > ALERT_DEDUPE_MS * 2) alertLastSent.delete(item);
        }
        if (typeof persistApiAlert === 'function') persistApiAlert(entry).catch(() => {});
        const endpoint = String(process.env.FINDER_ALERT_WEBHOOK || '').trim();
        if (endpoint) postAlertWebhook(endpoint, buildAlertPayload(entry));
    }

    return { createRequestId, logStructuredEvent, sendAlert };
}

module.exports = { createObservability };
