# Session-wide average TPS

The user wants Codex++ Session Stats to accumulate TPS across the conversation, as requested for Claude++. Preserve Codex's model-active-time measurement: official output tokens (including reasoning) divided by the union of model item intervals within each turn, excluding tool and user waiting.

Use the sum of valid turns' measured output divided by the sum of their matched measured durations. Do not average displayed turn rates or divide by session wall time. Retain the last matched sample during pending activity, so unmatched new intervals cannot distort the denominator. Starting a new turn keeps the accumulated rate, marked held until a valid new sample is available.

Incomplete timing/usage, missing turn starts and intervals shorter than 100 ms cannot contribute either tokens or duration. Valid zero-output turns contribute their duration. Later corrections replace a turn's contribution; invalidated samples are removed. Response/item replay stays deduplicated. Local and remote readers continue sharing the metrics core; their existing history selection and refresh limitations remain. Forked sessions retain their existing post-fork scope.

Only TPS, its matched modelActiveMs denominator, the tooltip and documentation change. The implementation request did not include a version bump, commit, push or release; the later publication authorization is recorded in the plan ledger.
