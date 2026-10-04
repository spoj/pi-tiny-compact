# pi-tiny-compact

Waitless compaction for [Pi](https://github.com/earendil-works/pi).

Pi compacts when the context crosses its threshold, then makes you wait while a summary is written. This extension writes the summary in the background before the threshold arrives, so compaction is instant when it does.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-compact@v0.6.0
```

## How it works

1. When the context comes within `keepRecentTokens` of Pi's compaction threshold, the extension sends the agent's next request again with one user message appended, asking for a summary. Model, thinking level, system prompt, tools, and messages are unchanged, so the request reuses the agent's prompt cache, and the model summarizes the real conversation rather than a serialized transcript.
2. You keep working. The footer shows `compact: running`, then `compact: ready`.
3. When Pi's threshold triggers, the summary replaces everything up to the point where it started. The conversation since then, about `keepRecentTokens`, stays verbatim.

If the summary is still running at the threshold, compaction waits for it, as Pi's own compaction would. Esc stops waiting, and the summary keeps running for the next attempt. If there is no summary yet, one is written then. If writing it fails, or the context overflows before a summary exists, Pi's built-in compaction runs.

Summaries use Pi's sections (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context). A later compaction updates the earlier summary rather than summarizing it. Each summary ends with the session file's path, so the agent can look up details that it dropped.

## Settings

Pi's own compaction settings drive everything:

- Threshold: `contextWindow - reserveTokens` (default reserve 16,384)
- Summary starts: `keepRecentTokens` earlier (default 20,000), which is also how much recent conversation stays verbatim and how long the summary has to finish
- `enabled: false` turns off automatic compaction and background summaries

For example, to compact a 1M-context model at 250,000 tokens and start its summary at 200,000:

```json
{
  "compaction": {
    "keepRecentTokens": 50000,
    "modelOverrides": {
      "anthropic/claude-opus-5-5": { "reserveTokens": 750000 }
    }
  }
}
```

## Manual compaction

`/compact` uses the ready summary, or writes one now. `/compact <focus>` always writes a fresh summary with that focus.

## Idle sessions

Providers keep a prompt cache for a few minutes, and the first request after it expires re-caches the whole context. When a session with a summary stays idle that long, the extension applies the summary first, so the next request re-caches the summary and recent messages instead.

The cache lifetime is the model's `promptCache` value for the active retention (`PI_CACHE_RETENTION=long` selects the long tier), or five minutes. Idle time counts from the last model response or cache-warming refresh.

## Compaction entries

Each compaction records the summary call's `usage`, so session totals include it, and `details`:

- `compactor`: `"pi-tiny-compact"`
- `throughEntryId`: the last session entry the summary covers
- `waitedMs`: how long compaction waited for the summary (`0` when it was ready)

The compacted entries stay in the session file; `/tree` returns to them with the full context.

## Development

```bash
npm test
```
