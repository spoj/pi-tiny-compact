# pi-tiny-compact

Compaction and branch summaries for [Pi](https://github.com/earendil-works/pi), written on the session's prompt cache.

Pi's own compaction and branch summaries send a serialized transcript to a separate summarizer prompt, so the request is uncached, and you wait while it runs. This extension writes both instead: the summary request is the conversation itself, so it reuses the agent's prompt cache, and compactions are usually written in the background before Pi's threshold arrives. Compactions also name the session for what it is about now.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-compact@v0.9.0
```

## How it works

A summary resends the input of the last model request with one user message appended, asking for a summary. Model, thinking level, system prompt, tools, and messages are unchanged, so the prompt cache covers all but that message, and the model summarizes the real conversation rather than a serialized transcript. The request fits the context window because the last one did, even after a context overflow. The summary replaces everything before the last response; that response and everything after it stay verbatim.

When the context comes within `keepRecentTokens` of Pi's compaction threshold, the extension writes a summary in the background, and the footer shows `compact: running`, then `compact: ready`. When the threshold triggers, the ready summary applies instantly, and the conversation since it started, about `keepRecentTokens`, stays verbatim. If it is still running, compaction waits for it; Esc stops waiting, and it keeps running for the next attempt. If it failed, or there is none, compaction writes one then.

Summary requests that fail transiently are retried per Pi's `retry` settings. If a summary still fails, the compaction is cancelled with a warning, and Pi's own compaction never runs. At the threshold, Pi tries again on the next turn; after a context overflow, the run stops, so run `/compact`, then continue.

The summary request skips extensions' `context` and `before_provider_request` handlers. If those change the agent's requests, summaries miss the prompt cache.

Summaries use Pi's sections (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context), and compaction summaries start with a title line, `# <title>`, saying what the session is about now. A summary updates the earlier summaries it covers rather than summarizing them. Each summary ends with the session file's path, so the agent can look up details that it dropped.

## Settings

Pi's own settings drive everything:

- Threshold: `contextWindow - reserveTokens` (default reserve 16,384)
- Summary starts: `keepRecentTokens` earlier (default 20,000), which is also how much recent conversation stays verbatim and how long the summary has to finish
- `enabled: false` turns off automatic compaction and background summaries
- `retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) applies to summary requests as to the agent's own

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

## Branch summaries

When you leave a branch with `/tree` and choose to summarize it, the summary request is the branch's whole context plus one message that quotes where the branch starts. The prompt cache covers all but the last response and that message. "Summarize with custom prompt" adds your text as a focus, as `/compact <focus>` does. The summary ends with the session file's path and the branch's last entry.

The summary is written when you leave, because the destination isn't known before. Requests are retried as for compaction; if the summary still fails, the navigation is cancelled with a warning, and Pi's own branch summary never runs. Pi asks whether to summarize unless `branchSummary.skipPrompt` is true.

## Idle sessions

Providers keep a prompt cache for a few minutes, and the first request after it expires re-caches the whole context. When a session with a summary stays idle that long, the extension applies the summary first, so the next request re-caches the summary and recent messages instead.

The cache lifetime is the model's `promptCache` for the retention in use (`PI_CACHE_RETENTION`), counted as Pi's cache warming counts it: from when the last request was sent, or from the last refresh. A model without one is not compacted for idleness, as Pi doesn't warm its cache either; a `modelOverrides` entry in `models.json` can declare it.

The cache lifetime is the model's `promptCache` value for the active retention (`PI_CACHE_RETENTION=long` selects the long tier), or five minutes. Idle time counts from the last model response or cache-warming refresh.

## Session names

`/resume` lists a session by its name, or else by its first message, which a session long enough to compact has usually drifted from. So each compaction (automatic, idle, or `/compact`) names the session with its summary's title line, which costs no extra request. The footer and terminal title show the name too.

A name you set with `/name` or `--name` is never replaced: the extension renames only a session that has no name or still has the name it set last. Compaction entries record the names it sets, so this holds across restarts. Branch summaries don't rename the session.

## Session entries

Each compaction and branch summary records the summary call's `usage`, so session totals include it, and `details`:

- `compactor`: `"pi-tiny-compact"`
- `waitedMs` (compactions only): how long compaction waited for the summary (`0` when it was ready)
- `sessionName` (compactions only): the name the compaction gave the session, absent when it gave none

The compacted entries stay in the session file; `/tree` returns to them with the full context.

## Development

```bash
npm ci
npm test
```
