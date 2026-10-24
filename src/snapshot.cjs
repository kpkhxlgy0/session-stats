'use strict';

function createSnapshotProtocol()
{
    const path = require('node:path');
    const maxBytes = 16384, maxRequestBytes = 1024, maxAgeMs = 30000, futureSkewMs = 5000;
    const pollMs = 2000, heartbeatMs = 10000;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const session = /^rollout-(.+?)-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i;
    const counts = ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'modelActiveMs'];
    const statKeys = [...counts, 'cacheHit', 'tps', 'tpsHeld', 'activeTurn', 'status'];
    const rootKeys = ['schemaVersion', 'producer', 'threadId', 'publisherId', 'revision', 'generatedAt', 'stats'];
    const requestKeys = ['schemaVersion', 'producer', 'threadId', 'requestedAt'];
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));

    function normalizeThreadId(value)
    {
        return typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null;
    }

    function safePath(value, suppliedPathApi)
    {
        if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
        const pathApi = suppliedPathApi || (/^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix);
        const windows = pathApi.sep === '\\';
        if (!pathApi.isAbsolute(value) || !windows && value.includes('\\')) return null;
        let parts = value.split(/[\\/]/).filter(Boolean);
        if (windows)
        {
            if (value.startsWith('\\\\?\\'))
            {
                if (value.includes('/') || !/^\\\\\?\\(?:[a-z]:\\|UNC\\[^\\]+\\[^\\]+(?:\\|$))/i.test(value)) return null;
                parts = parts.slice(1);
            }
            else if (!/^[a-z]:[\\/]/i.test(value) && !/^\\\\[^\\/?]+\\[^\\/?]+(?:\\|$)/.test(value)) return null;
            for (let index = 0; index < parts.length; index++)
            {
                const part = parts[index];
                if (index === 0 && /^[a-z]:$/i.test(part)) continue;
                if (/[. ]$|[<>:"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return null;
            }
        }
        if (parts.some(part => part === '.' || part === '..')) return null;
        return { pathApi, filename: pathApi.normalize(value) };
    }

    function snapshotPath(codexHome, threadId, pathApi)
    {
        const id = normalizeThreadId(threadId);
        const home = safePath(codexHome, pathApi);
        return id && home ? home.pathApi.join(home.filename, '.session-stats', `${id}.json`) : null;
    }

    function requestPath(codexHome, threadId, requestId, pathApi)
    {
        const id = normalizeThreadId(threadId);
        const nonce = normalizeThreadId(requestId);
        const home = safePath(codexHome, pathApi);
        return id && nonce && home
            ? home.pathApi.join(home.filename, '.session-stats', 'requests', `${id}.${nonce}.json`) : null;
    }

    function remoteContext(rolloutPath, threadId)
    {
        const id = normalizeThreadId(threadId);
        const context = safePath(rolloutPath);
        if (!id || !context) return null;
        const { pathApi, filename } = context;
        const match = session.exec(pathApi.basename(filename));
        if (!match || normalizeThreadId(match[2]) !== id || match[3] && !normalizeThreadId(match[3])) return null;
        let directory = pathApi.dirname(filename);
        while (directory !== pathApi.dirname(directory))
        {
            const name = pathApi.basename(directory);
            if ((pathApi.sep === '\\' ? /^(sessions|archived_sessions)$/i : /^(sessions|archived_sessions)$/).test(name))
            {
                const codexHome = pathApi.dirname(directory);
                const file = snapshotPath(codexHome, id, pathApi);
                return file ? { codexHome, directory: pathApi.dirname(file), file, pathApi } : null;
            }
            directory = pathApi.dirname(directory);
        }
        return null;
    }

    function projectStats(raw)
    {
        if (!record(raw) || !['ok', 'not-found', 'unavailable'].includes(raw.status)) return null;
        const ok = raw.status === 'ok';
        const stats = {};
        for (const field of counts)
        {
            const value = raw[field] === undefined ? null : raw[field];
            if (ok && value !== null && (field === 'modelActiveMs'
                ? !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
                : !integer(value))) return null;
            stats[field] = ok ? value : null;
        }
        for (const field of ['cacheHit', 'tps'])
        {
            const value = raw[field] === undefined ? null : raw[field];
            if (ok && value !== null && (typeof value !== 'number' || !Number.isFinite(value)
                || value < 0 || field === 'cacheHit' && value > 1)) return null;
            stats[field] = ok ? value : null;
        }
        for (const field of ['tpsHeld', 'activeTurn'])
        {
            if (ok && typeof raw[field] !== 'boolean') return null;
            stats[field] = ok && raw[field];
        }
        stats.status = raw.status;
        return stats;
    }

    function makeSnapshot(threadId, raw, options = {})
    {
        if (!record(options)) return null;
        const id = normalizeThreadId(threadId);
        const publisherId = normalizeThreadId(options.publisherId);
        const stats = projectStats(raw);
        if (!id || !publisherId || !integer(options.revision) || options.revision === 0
            || !integer(options.now) || !stats) return null;
        return { schemaVersion: 1, producer: 'codex-session-stats', threadId: id, publisherId,
            revision: options.revision, generatedAt: options.now, stats };
    }

    function canonicalSnapshot(value)
    {
        if (!exactKeys(value, rootKeys) || !exactKeys(value.stats, statKeys)
            || value.schemaVersion !== 1 || value.producer !== 'codex-session-stats') return null;
        const snapshot = makeSnapshot(value.threadId, value.stats, {
            publisherId: value.publisherId, revision: value.revision, now: value.generatedAt,
        });
        return snapshot && snapshot.threadId === value.threadId && snapshot.publisherId === value.publisherId
            && statKeys.every(key => snapshot.stats[key] === value.stats[key]) ? snapshot : null;
    }

    function parseSnapshot(text, expected = {})
    {
        const invalid = reason => ({ ok: false, reason });
        if (typeof text !== 'string' || text.length > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes
            || !record(expected) || !integer(expected.now)) return invalid('invalid');
        let value;
        try { value = JSON.parse(text); }
        catch { return invalid('invalid'); }
        const snapshot = canonicalSnapshot(value);
        if (!snapshot) return invalid('invalid');
        if (snapshot.threadId !== normalizeThreadId(expected.threadId)) return invalid('identity');
        if (snapshot.generatedAt - expected.now > futureSkewMs) return invalid('future');
        if (expected.now - snapshot.generatedAt > maxAgeMs) return invalid('expired');
        return { ok: true, snapshot };
    }

    function makeRequest(threadId, options = {})
    {
        const id = normalizeThreadId(threadId);
        if (!id || !record(options) || !integer(options.now)) return null;
        return { schemaVersion: 1, producer: 'codex-session-stats-request', threadId: id, requestedAt: options.now };
    }

    function parseRequest(text, expected = {})
    {
        const invalid = reason => ({ ok: false, reason });
        if (typeof text !== 'string' || text.length > maxRequestBytes || Buffer.byteLength(text, 'utf8') > maxRequestBytes
            || !record(expected) || !integer(expected.now)) return invalid('invalid');
        let value;
        try { value = JSON.parse(text); }
        catch { return invalid('invalid'); }
        if (!exactKeys(value, requestKeys) || value.schemaVersion !== 1
            || value.producer !== 'codex-session-stats-request') return invalid('invalid');
        const request = makeRequest(value.threadId, { now: value.requestedAt });
        if (!request || request.threadId !== value.threadId) return invalid('invalid');
        if (request.threadId !== normalizeThreadId(expected.threadId)) return invalid('identity');
        if (request.requestedAt - expected.now > futureSkewMs) return invalid('future');
        if (expected.now - request.requestedAt > maxAgeMs) return invalid('expired');
        return { ok: true, request };
    }

    function toStats(value)
    {
        const snapshot = canonicalSnapshot(value);
        if (!snapshot) return null;
        return { ...snapshot.stats, threadId: snapshot.threadId, source: 'snapshot',
            snapshotGeneratedAt: snapshot.generatedAt, snapshotRevision: snapshot.revision,
            snapshotPublisherId: snapshot.publisherId,
            ...(snapshot.stats.status === 'ok' ? {} : { unavailableReason: 'source-unavailable' }) };
    }

    return { normalizeThreadId, snapshotPath, requestPath, remoteContext, projectStats, makeSnapshot, parseSnapshot,
        makeRequest, parseRequest, toStats, maxBytes, maxRequestBytes, maxAgeMs, futureSkewMs, pollMs, heartbeatMs };
}

module.exports = { createSnapshotProtocol };
