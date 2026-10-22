'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMetrics } = require('../src/metrics.cjs');

function event(type, turnId, fields = {})
{
    return { type: 'event_msg', payload: { type, turn_id: turnId, ...fields } };
}

function usage(turnId, responseId, outputTokens, totals)
{
    return {
        type: 'token_usage_record',
        payload: {
            thread_id: 'thread-1',
            turn_id: turnId,
            response_id: responseId,
            usage: { output_tokens: outputTokens, reasoning_output_tokens: outputTokens / 2 },
            thread_token_usage: totals
        }
    };
}

test('an empty session reports unknown measurements instead of invented zero usage', () =>
{
    const metrics = createMetrics();
    assert.deepEqual(metrics.snapshot(), {
        turns: 0,
        steps: null,
        totalTokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        cacheHit: null,
        tps: null,
        tpsHeld: false,
        activeTurn: false,
        modelActiveMs: 0
    });
});

test('cumulative snapshots replace previous values without adding cached or reasoning tokens', () =>
{
    const metrics = createMetrics();
    metrics.ingest(usage('turn-1', 'response-1', 100, {
        input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100,
        reasoning_output_tokens: 50, total_tokens: 1100
    }));
    metrics.ingest(event('token_count', 'turn-1', { info: { total_token_usage: {
        input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 300, total_tokens: 2300
    } } }));
    metrics.ingest(usage('turn-1', 'response-2', 400, {
        input_tokens: 3000, cached_input_tokens: 2400, output_tokens: 700, total_tokens: 3700
    }));
    metrics.ingest(event('token_count', 'turn-1', { info: { total_token_usage: {
        input_tokens: 3000, cached_input_tokens: 2400, output_tokens: 700, total_tokens: 3700
    } } }));
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.totalTokens, 3700);
    assert.equal(snapshot.inputTokens, 3000);
    assert.equal(snapshot.outputTokens, 700);
    assert.equal(snapshot.cachedInputTokens, 2400);
    assert.equal(snapshot.cacheHit, 0.8);
});

test('turns and model responses are distinct IDs while repeated carriers do not add steps', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(usage('turn-1', 'response-1', 100));
    metrics.ingest(usage('turn-1', 'response-1', 100));
    metrics.ingest(event('token_count', 'turn-1', { info: { last_token_usage: { output_tokens: 100 } } }));
    metrics.ingest(event('task_complete', 'turn-1'));
    metrics.ingest(event('task_started', 'turn-2'));
    metrics.ingest(usage('turn-2', 'response-2', 200));
    assert.equal(metrics.snapshot().turns, 2);
    assert.equal(metrics.snapshot().steps, 2);
    assert.equal(metrics.snapshot().activeTurn, true);
    metrics.ingest(event('task_complete', 'turn-2'));
    assert.equal(metrics.snapshot().activeTurn, false);
});
function item(turnId, type, id, start, end)
{
    return event('item_completed', turnId, {
        item: { type, id }, started_at_ms: start, completed_at_ms: end
    });
}

test('TPS divides official output by model activity while excluding five seconds of tools', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', 0, 3000));
    metrics.ingest(item('turn-1', 'CommandExecution', 'command-1', 3000, 8000));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 8000, 12000));
    metrics.ingest(usage('turn-1', 'response-1', 1400));
    metrics.ingest(usage('turn-1', 'response-1', 1400));
    metrics.ingest(event('token_count', 'turn-1', { info: { last_token_usage: { output_tokens: 1400 } } }));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().modelActiveMs, 7000);
    assert.equal(metrics.snapshot().steps, 1);
    metrics.ingest(event('task_complete', 'turn-1'));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().tpsHeld, false);
});

test('overlapping model intervals count their union once', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', 0, 4000));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 2000, 6000));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', 0, 4000));
    metrics.ingest(usage('turn-1', 'response-1', 600));
    metrics.ingest(usage('turn-1', 'response-2', 600));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().modelActiveMs, 6000);
});

test('tool activity holds the measurement until newer official usage arrives', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 0, 1000));
    metrics.ingest(usage('turn-1', 'response-1', 200));
    assert.equal(metrics.snapshot().tpsHeld, false);
    metrics.ingest(item('turn-1', 'CommandExecution', 'command-1', 1000, 6000));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().tpsHeld, true);
    metrics.ingest(usage('turn-1', 'response-2', 0));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().tpsHeld, false);
    metrics.ingest(item('turn-1', 'CommandExecution', 'command-2', 6000, 7000));
    metrics.ingest(event('task_complete', 'turn-1'));
    assert.equal(metrics.snapshot().tpsHeld, false);
});

test('a newer turn clears speed and never borrows earlier turn tokens or intervals', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 0, 1000));
    metrics.ingest(usage('turn-1', 'response-1', 200));
    metrics.ingest(event('task_complete', 'turn-1'));
    metrics.ingest(event('task_started', 'turn-2'));
    assert.equal(metrics.snapshot().tps, null);
    assert.equal(metrics.snapshot().modelActiveMs, 0);
    metrics.ingest(usage('turn-2', 'response-2', 100));
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(usage('turn-1', 'response-1', 200));
    assert.equal(metrics.snapshot().tps, null);
});

test('checkpoint history preserves cumulative totals without fabricating incomplete-turn speed', () =>
{
    const metrics = createMetrics();
    const record = usage('turn-7', 'response-20', 200, {
        input_tokens: 80000, cached_input_tokens: 40000, output_tokens: 20000, total_tokens: 100000
    });
    record.payload.turn_token_usage = { output_tokens: 20000, total_tokens: 100000 };
    metrics.ingest(item('turn-7', 'AgentMessage', 'message-20', 0, 1000));
    metrics.ingest(record);
    assert.equal(metrics.snapshot().totalTokens, 100000);
    assert.equal(metrics.snapshot().tps, null);
    assert.equal(metrics.snapshot().steps, 1);
    assert.equal(metrics.snapshot().turns, 1);
});

test('legacy cumulative data keeps steps and TPS unknown without response IDs', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 0, 1000));
    metrics.ingest(event('token_count', 'turn-1', { info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200, total_tokens: 1200 },
        last_token_usage: { output_tokens: 200 }
    } }));
    assert.equal(metrics.snapshot().totalTokens, 1200);
    assert.equal(metrics.snapshot().cacheHit, 0.5);
    assert.equal(metrics.snapshot().steps, null);
    assert.equal(metrics.snapshot().tps, null);
});

for (const [label, start, end] of [
    ['missing start', undefined, 1000],
    ['missing completion', 0, undefined],
    ['zero duration', 1000, 1000],
    ['backwards interval', 2000, 1000],
    ['negative timestamp', -1, 1000],
    ['non-finite start', NaN, 1000],
    ['non-finite completion', 0, Infinity],
    ['string timestamp', '0', 1000],
    ['tiny interval', 0, 50]
])
{
    test(`TPS stays unknown for ${label}`, () =>
    {
        const metrics = createMetrics();
        metrics.ingest(event('task_started', 'turn-1'));
        metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', start, end));
        metrics.ingest(usage('turn-1', 'response-1', 200));
        assert.equal(metrics.snapshot().tps, null);
    });
}

test('one missing model interval prevents a partial denominator from inflating speed', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', undefined, 2000));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 2000, 3000));
    metrics.ingest(usage('turn-1', 'response-1', 600));
    assert.equal(metrics.snapshot().tps, null);
});

test('a zero-length model item does not invalidate other measured intervals in the turn', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', 0, 2000));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 2000, 2000));
    metrics.ingest(usage('turn-1', 'response-1', 400));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().modelActiveMs, 2000);
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-2', 3000, 4000));
    metrics.ingest(usage('turn-1', 'response-2', 200));
    metrics.ingest(event('task_complete', 'turn-1'));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().modelActiveMs, 3000);
});

test('long model intervals remain measurable without an arbitrary reasoning time cap', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', 0, 900000));
    metrics.ingest(usage('turn-1', 'response-1', 90000));
    assert.equal(metrics.snapshot().modelActiveMs, 900000);
    assert.equal(metrics.snapshot().tps, 100);
});

test('malformed and unknown records cannot corrupt a valid measurement', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 0, 1000));
    metrics.ingest(usage('turn-1', 'response-1', 200, {
        input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200, total_tokens: 1200
    }));
    for (const record of [null, [], {}, { type: 'event_msg', payload: null },
        { type: 'future_record', payload: { turn_id: 'unknown' } },
        event('future_event', 'unknown'),
        item('turn-1', 'UserMessage', 'user-1', 0, 100000),
        usage('turn-1', 'response-1', 200, { input_tokens: 'bad', total_tokens: -1 })])
    {
        metrics.ingest(record);
    }
    assert.equal(metrics.snapshot().turns, 1);
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().modelActiveMs, 1000);
    assert.equal(metrics.snapshot().totalTokens, 1200);
});
test('new model intervals hold the last matched rate until usage catches up', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 0, 1000));
    metrics.ingest(usage('turn-1', 'response-1', 200));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-2', 6000, 7000));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().tpsHeld, true);
    metrics.ingest(usage('turn-1', 'response-2', 400));
    assert.equal(metrics.snapshot().tps, 300);
    assert.equal(metrics.snapshot().tpsHeld, false);
});

test('completion matches usage that arrived before the final model interval', () =>
{
    const metrics = createMetrics();
    metrics.ingest(event('task_started', 'turn-1'));
    metrics.ingest(usage('turn-1', 'response-1', 1400));
    metrics.ingest(item('turn-1', 'Reasoning', 'reason-1', 0, 3000));
    metrics.ingest(item('turn-1', 'AgentMessage', 'message-1', 8000, 12000));
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(event('task_complete', 'turn-1'));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().tpsHeld, false);
});
test('orphan item records do not invent turns without a task or usage marker', () =>
{
    const metrics = createMetrics();
    metrics.ingest(item('unbound-turn', 'AgentMessage', 'message-1', 0, 1000));
    assert.equal(metrics.snapshot().turns, 0);
    assert.equal(metrics.snapshot().tps, null);
});
test('a replayed response cannot roll cumulative totals back after a newer response', () =>
{
    const metrics = createMetrics();
    const first = usage('turn-1', 'response-1', 100, {
        input_tokens: 900, cached_input_tokens: 450, output_tokens: 100, total_tokens: 1000
    });
    metrics.ingest(first);
    metrics.ingest(usage('turn-1', 'response-2', 100, {
        input_tokens: 1800, cached_input_tokens: 1350, output_tokens: 200, total_tokens: 2000
    }));
    metrics.ingest(first);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.steps, 2);
    assert.equal(snapshot.totalTokens, 2000);
    assert.equal(snapshot.inputTokens, 1800);
    assert.equal(snapshot.outputTokens, 200);
    assert.equal(snapshot.cachedInputTokens, 1350);
    assert.equal(snapshot.cacheHit, 0.75);
});

test('cumulative-only usage without a response ID can still recover session totals', () =>
{
    const metrics = createMetrics();
    metrics.ingest(usage('turn-1', undefined, 100, {
        input_tokens: 900, cached_input_tokens: 450, output_tokens: 100, total_tokens: 1000
    }));
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.totalTokens, 1000);
    assert.equal(snapshot.cacheHit, 0.5);
    assert.equal(snapshot.steps, null);
    assert.equal(snapshot.tps, null);
});
