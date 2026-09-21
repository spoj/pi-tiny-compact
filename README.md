# pi-tiny-compact

A small deterministic conversation compactor for [Pi](https://github.com/earendil-works/pi).

It makes no model calls. Pi chooses what history to compact and what recent context to retain; this extension only converts the discarded span into a bounded factual transcript.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-compact@v0.2.0
```

## Usage

Once installed, use Pi normally:

```text
/compact
```

The extension supplies the result for every compaction reason: manual `/compact`, automatic threshold compaction, and overflow recovery. Pi still chooses the cut and retains recent context.

Focused compaction such as `/compact focus on auth` is cancelled with a warning because deterministic logic cannot interpret the focus request.

The generated summary contains:

- the initial request when available;
- a bounded inherited summary when taking over from another compactor;
- files reported by Pi as read or modified;
- recent user, assistant, tool-call, tool-result, custom-context, and shell records.

Tool results are retained with larger allowances for errors. Assistant thinking is omitted. Message text is indented beneath generated role headers so it cannot alter the persisted summary structure.

## Bounds

- Complete summary: 12,000 characters
- Initial request: 1,200 characters
- Inherited summary: 3,000 characters
- User or assistant record: 1,200 characters
- Tool call: 500 characters
- Successful tool result: 600 characters
- Failed tool result: 1,200 characters
- Remembered files: 50 per category

Older transcript records roll off when the summary reaches its limit. The original session entries remain in Pi's session file, but this extension does not claim lossless recall.

Repeated compactions merge structured state stored in the compaction entry's `details`; they never parse generated summary text.

## Development

```bash
npm test
```
