'use strict';

const ModelItemTypes = new Set(['Reasoning', 'AgentMessage']);
const ToolItemTypes = new Set(['CommandExecution', 'WebSearch', 'FileChange', 'ImageView', 'ImageGeneration']);
// 过短的区间会放大时间戳精度误差。
const MinimumModelMs = 100;

function isRecord(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value)
{
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readTotals(value)
{
    if (!isRecord(value)) return null;
    const totals = {
        totalTokens: tokenCount(value.total_tokens),
        inputTokens: tokenCount(value.input_tokens),
        outputTokens: tokenCount(value.output_tokens),
        cachedInputTokens: tokenCount(value.cached_input_tokens)
    };
    return Object.values(totals).some(count => count !== null) ? totals : null;
}

function unionDuration(intervals)
{
    let duration = 0;
    let previousEnd = -1;
    for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0]))
    {
        duration += Math.max(0, end - Math.max(start, previousEnd));
        previousEnd = Math.max(previousEnd, end);
    }
    return duration;
}

function measure(turn)
{
    const duration = unionDuration(turn.intervals);
    if (!turn.started || !turn.hasUsage || turn.incompleteUsage || turn.incompleteTiming
        || duration < MinimumModelMs || !Number.isSafeInteger(turn.outputTokens)) return null;
    return { outputTokens: turn.outputTokens, modelActiveMs: duration };
}

function createMetrics({ responseTotals = false } = {})
{
    const turns = new Map();
    const responses = new Set();
    let currentTurnId;
    let totals = { totalTokens: null, inputTokens: null, outputTokens: null, cachedInputTokens: null };
    let missingResponseIdentity = false;

    function getTurn(turnId)
    {
        if (typeof turnId !== 'string' || !turnId) return null;
        if (!turns.has(turnId))
        {
            turns.set(turnId, {
                started: false,
                completed: false,
                intervals: [],
                items: new Set(),
                outputTokens: 0,
                hasUsage: false,
                incompleteUsage: false,
                incompleteTiming: false,
                pendingActivity: false,
                sample: null
            });
            currentTurnId = turnId;
        }
        return turns.get(turnId);
    }

    function ingestUsage(payload)
    {
        if (responses.has(payload.response_id)) return;
        const turn = getTurn(payload.turn_id);
        const hasResponseId = typeof payload.response_id === 'string' && Boolean(payload.response_id);
        if (responseTotals)
        {
            // 分叉会话仅累计当前分支的响应，不能沿用包含父历史的会话总量。
            if (!hasResponseId) missingResponseIdentity = true;
            const usage = readTotals(payload.usage);
            for (const key of Object.keys(totals))
            {
                const value = usage?.[key] ?? null;
                const previous = responses.size ? totals[key] : 0;
                const sum = previous + value;
                totals[key] = !missingResponseIdentity && previous !== null && value !== null
                    && Number.isSafeInteger(sum) ? sum : null;
            }
        }
        else totals = readTotals(payload.thread_token_usage) || totals;
        if (!hasResponseId)
        {
            if (turn)
            {
                turn.incompleteUsage = true;
                turn.sample = null;
            }
            return;
        }
        responses.add(payload.response_id);
        if (!turn) return;
        const output = tokenCount(payload.usage?.output_tokens);
        turn.hasUsage = true;
        if (output === null) turn.incompleteUsage = true;
        else turn.outputTokens += output;
        turn.sample = measure(turn);
        turn.pendingActivity = false;
    }

    function ingestItem(payload)
    {
        if (!isRecord(payload.item)) return;
        const type = payload.item.type;
        const isModel = ModelItemTypes.has(type);
        const isTool = ToolItemTypes.has(type) || (typeof type === 'string' && type.endsWith('ToolCall'));
        if (!isModel && !isTool) return;
        const turn = turns.get(payload.turn_id);
        if (!turn) return;
        const start = payload.started_at_ms;
        const end = payload.completed_at_ms;
        const key = typeof payload.item.id === 'string' && payload.item.id
            ? `${type}:${payload.item.id}` : JSON.stringify([type, start, end]);
        if (turn.items.has(key)) return;
        turn.items.add(key);
        turn.pendingActivity = true;
        if (isModel)
        {
            if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start)
            {
                turn.intervals.push([start, end]);
            }
            else
            {
                turn.incompleteTiming = true;
                turn.sample = null;
            }
        }
        if (turn.completed)
        {
            turn.sample = measure(turn);
            turn.pendingActivity = false;
        }
    }

    function ingest(record)
    {
        if (!isRecord(record) || !isRecord(record.payload)) return;
        const payload = record.payload;
        if (record.type === 'token_usage_record') ingestUsage(payload);
        else if (record.type === 'event_msg')
        {
            if (payload.type === 'task_started' || payload.type === 'task_complete')
            {
                const turn = getTurn(payload.turn_id);
                if (!turn) return;
                if (payload.type === 'task_started') turn.started = true;
                else
                {
                    turn.completed = true;
                    turn.sample = measure(turn);
                    turn.pendingActivity = false;
                }
            }
            else if (payload.type === 'item_completed') ingestItem(payload);
            else if (payload.type === 'token_count' && !responseTotals)
            {
                totals = readTotals(payload.info?.total_token_usage) || totals;
            }
        }
    }

    function snapshot()
    {
        const turn = turns.get(currentTurnId);
        let measuredOutput = 0;
        let modelActiveMs = 0;
        for (const measured of turns.values())
        {
            // Keep each usage/duration pair together while newer activity is pending.
            if (!measured.sample) continue;
            measuredOutput += measured.sample.outputTokens;
            modelActiveMs += measured.sample.modelActiveMs;
        }
        const tps = Number.isSafeInteger(measuredOutput) && Number.isFinite(modelActiveMs)
            && modelActiveMs >= MinimumModelMs && modelActiveMs <= Number.MAX_SAFE_INTEGER
            ? measuredOutput * 1000 / modelActiveMs : null;
        const cacheHit = totals.inputTokens > 0 && totals.cachedInputTokens !== null
            && totals.cachedInputTokens <= totals.inputTokens
            ? totals.cachedInputTokens / totals.inputTokens : null;
        return {
            turns: turns.size,
            steps: responses.size || null,
            ...totals,
            cacheHit,
            tps,
            tpsHeld: Boolean(tps !== null && turn?.started && !turn.completed
                && (turn.pendingActivity || !turn.sample)),
            activeTurn: Boolean(turn?.started && !turn.completed),
            modelActiveMs
        };
    }

    return { ingest, snapshot };
}

module.exports = { createMetrics };
