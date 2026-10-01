# pi-tiny-compact

A small deterministic conversation compactor for [Pi](https://github.com/earendil-works/pi).

It makes no model calls. Pi chooses what history to compact and what recent context to retain; this extension only converts the discarded span into a bounded factual transcript. It also compacts large sessions once they have been idle long enough for the provider's prompt cache to expire.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-compact@v0.4.0
```

## Usage

Once installed, use Pi normally:

```text
/compact
```

The extension supplies the result for every compaction reason: manual `/compact`, automatic threshold compaction, overflow recovery, and [idle compaction](#idle-compaction). Pi still chooses the cut and retains recent context.

Focused compaction such as `/compact focus on auth` is cancelled with a warning because deterministic logic cannot interpret the focus request.

The generated summary contains:

- the initial request when available;
- a bounded inherited summary when taking over from another compactor;
- files reported by Pi as read or modified;
- user, assistant, tool-call, tool-result, custom-context, and shell records, in order.

Tool results are retained with larger allowances for errors. Assistant thinking is omitted. Message text is indented beneath generated role headers so it cannot alter the persisted summary structure.

## Idle compaction

Providers keep a prompt cache for a few minutes. The first request after it expires pays to cache the whole context again, which is expensive for a large session. When a run ends and the session then stays idle for its cache lifetime, pi-tiny-compact compacts it if the context holds at least 100,000 tokens. The next request then re-caches the summary and recent messages instead of the full history.

- The cache lifetime is the model's `promptCache` value for the active retention (`PI_CACHE_RETENTION=long` selects the long tier), or five minutes when the model declares none.
- Idle time counts from the last model response or cache-warming refresh, so with `cacheWarming: "idle"` compaction waits until Pi stops warming the cache.
- A new run restarts the idle time. Nothing happens when `compaction.enabled` is `false`.
- The compacted entries stay in the session file; `/tree` returns to them with the full context.

## Bounds

- Complete summary: 32,000 characters
- Initial request: 1,200 characters
- Inherited summary: 3,000 characters
- User or assistant record: 1,200 characters
- Tool call: 500 characters
- Successful tool result: 600 characters
- Failed tool result: 1,200 characters
- Remembered files: 50 per category

When the summary reaches its limit, tool activity and custom context roll off first, then assistant text, then user messages, oldest first within each. User instructions therefore survive long tool-heavy runs and repeated compactions. The original session entries remain in Pi's session file, but this extension does not claim lossless recall.

Repeated compactions merge structured state stored in the compaction entry's `details`; they never parse generated summary text.

## Development

```bash
npm test
```
