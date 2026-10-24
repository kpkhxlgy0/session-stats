'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createSnapshotProtocol } = require('./snapshot.cjs');

const SessionPattern = /^rollout-(.+?)-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i;
const MaxDirectories = 2048;
const MaxFilenames = 50000;
const MaxDepth = 3;
const MaxRecentIds = 8;
const MaxRequestEntries = 256;

function fileVersion(info)
{
    return `${info.dev}:${info.ino}:${info.birthtimeMs}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function readSnapshotRequest(file, threadId, { protocol, now, fileSystem, signal })
{
    let source;
    try
    {
        const before = await fileSystem.lstat(file);
        if (signal?.aborted || !before.isFile() || before.isSymbolicLink() || before.size > protocol.maxRequestBytes
            || typeof process.getuid === 'function' && before.uid !== process.getuid()) return null;
        source = await fileSystem.open(file, 'r');
        const opened = await source.stat();
        if (signal?.aborted || !opened.isFile() || fileVersion(before) !== fileVersion(opened)) return null;
        const buffer = Buffer.alloc(protocol.maxRequestBytes + 1);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
        const after = await fileSystem.lstat(file);
        if (signal?.aborted || bytesRead > protocol.maxRequestBytes || after.isSymbolicLink()
            || fileVersion(before) !== fileVersion(after)) return null;
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const parsed = protocol.parseRequest(text, { threadId, now });
        let request = parsed.request;
        if (!parsed.ok)
        {
            if (parsed.reason !== 'expired') return null;
            const owner = protocol.parseRequest(text, { threadId, now: JSON.parse(text).requestedAt });
            if (!owner.ok) return null;
            request = owner.request;
        }
        return { file, request, expired: !parsed.ok, text, version: fileVersion(before) };
    }
    catch (error)
    {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        return null;
    }
    finally { await source?.close(); }
}

async function discoverSnapshotRequests(directory, { now = Date.now(), fileSystem = fs, signal } = {})
{
    if (signal?.aborted || typeof directory !== 'string' || !path.isAbsolute(directory)) return [];
    const protocol = createSnapshotProtocol();
    const requests = [];
    try
    {
        const info = await fileSystem.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || signal?.aborted) return [];
        const handle = await fileSystem.opendir(directory);
        let count = 0;
        for await (const child of handle)
        {
            if (signal?.aborted) break;
            count++;
            const match = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.json$/i.exec(child.name);
            const threadId = match && protocol.normalizeThreadId(match[1]);
            const requestId = match && protocol.normalizeThreadId(match[2]);
            if (threadId && requestId && child.isFile() && !child.isSymbolicLink())
            {
                const file = path.join(directory, child.name);
                const request = await readSnapshotRequest(file, threadId, { protocol, now, fileSystem, signal });
                if (request) requests.push(request);
            }
            if (count >= MaxRequestEntries || signal?.aborted) break;
        }
    }
    catch (error)
    {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
    return signal?.aborted ? [] : requests;
}

async function discoverRecentThreadIds(codexHome, { fileSystem = fs, signal } = {})
{
    if (signal?.aborted || typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) return [];
    try
    {
        const home = await fileSystem.lstat(codexHome);
        if (!home.isDirectory() || home.isSymbolicLink() || signal?.aborted) return [];
    }
    catch (error)
    {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
        throw error;
    }
    const protocol = createSnapshotProtocol();
    const recent = new Map();
    const directories = ['archived_sessions', 'sessions'].map(name =>
        ({ directory: path.join(codexHome, name), depth: 0 }));
    let directoryCount = 0, filenameCount = 0;
    while (directories.length && directoryCount < MaxDirectories && filenameCount < MaxFilenames && !signal?.aborted)
    {
        const { directory, depth } = directories.pop();
        directoryCount++;
        try
        {
            const info = await fileSystem.lstat(directory);
            if (signal?.aborted) break;
            if (!info.isDirectory() || info.isSymbolicLink()) continue;
            const handle = await fileSystem.opendir(directory);
            for await (const child of handle)
            {
                if (signal?.aborted) break;
                filenameCount++;
                if (child.isSymbolicLink()) { /* Never follow linked files or directories. */ }
                else if (child.isDirectory() && depth < MaxDepth
                    && directoryCount + directories.length < MaxDirectories)
                {
                    directories.push({ directory: path.join(directory, child.name), depth: depth + 1 });
                }
                else if (child.isFile())
                {
                    const match = SessionPattern.exec(child.name);
                    const threadId = match && protocol.normalizeThreadId(match[2]);
                    const file = path.join(directory, child.name);
                    if (threadId && protocol.remoteContext(file, threadId))
                    {
                        try
                        {
                            const latest = await fileSystem.lstat(file);
                            if (latest.isFile() && !latest.isSymbolicLink() && Number.isFinite(latest.mtimeMs))
                            {
                                recent.set(threadId, Math.max(recent.get(threadId) ?? -Infinity, latest.mtimeMs));
                                if (recent.size > MaxRecentIds)
                                {
                                    const oldest = [...recent].sort((left, right) =>
                                        left[1] - right[1] || right[0].localeCompare(left[0]))[0];
                                    recent.delete(oldest[0]);
                                }
                            }
                        }
                        catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
                    }
                }
                if (filenameCount >= MaxFilenames || signal?.aborted) break;
            }
        }
        catch (error)
        {
            if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        }
    }
    return signal?.aborted ? [] : [...recent].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])).map(([threadId]) => threadId);
}

module.exports = { discoverRecentThreadIds, discoverSnapshotRequests };
