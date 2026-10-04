import assert from "node:assert/strict";
import test from "node:test";
import tinyCompact, { INSTRUCTION } from "../index.ts";

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
// codex: 272,000 window - 16,384 default reserve - 50,000 keepRecentTokens
const PRECOMPUTE_AT = 205_616;

const session = () => {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const settings: Record<string, any> = { compaction: { keepRecentTokens: 50_000 } };
  tinyCompact({
    on: (name: string, handler: (event: any, ctx: any) => any) => { handlers[name] = handler; },
    getSettings: () => settings,
    getThinkingLevel: () => "high",
  } as never);

  const requests: Array<{ context: any; options: any; finish: (response: unknown) => void }> = [];
  const state = {
    tokens: 0,
    branch: [{ id: "a" }, { id: "b" }] as any[],
    idle: true,
    status: undefined as string | undefined,
    notes: [] as string[],
    compactions: 0,
  };
  const ctx = {
    model: { provider: "openai-codex", id: "gpt", promptCache: { short: 300, long: 3600 } },
    sessionManager: {
      getLeafId: () => state.branch.at(-1).id,
      getBranch: () => state.branch,
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/s.jsonl",
    },
    getContextUsage: () => ({ tokens: state.tokens, contextWindow: 272_000 }),
    modelRegistry: {
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        let finish!: (response: unknown) => void;
        const result = new Promise((resolve) => { finish = resolve; });
        requests.push({ context, options, finish });
        return { result: () => result };
      },
    },
    ui: {
      setStatus: (_key: string, text: string | undefined) => { state.status = text; },
      notify: (message: string) => state.notes.push(message),
    },
    isIdle: () => state.idle,
    compact: () => { state.compactions++; },
  };
  const llmMessages = [{ role: "system", content: "prompt" }, { role: "user", content: "build it" }];

  return {
    handlers, settings, state, ctx, requests, llmMessages,
    turnEnd: (tokens: number, outcome = "completed") => {
      state.tokens = tokens;
      handlers.turn_end({ outcome, context: { llmMessages } }, ctx);
    },
    compact: (event: Record<string, unknown> = {}) => handlers.session_before_compact({
      reason: "threshold",
      signal: new AbortController().signal,
      branchEntries: state.branch,
      preparation: { tokensBefore: 260_000 },
      ...event,
    }, ctx),
    reply: async (text: string, stopReason = "stop") => {
      requests.at(-1)!.finish({ content: [{ type: "text", text }], stopReason, usage, errorMessage: stopReason === "error" ? "rate limited" : undefined });
      await flush();
    },
  };
};

test("starts keepRecentTokens before Pi's threshold, as the agent's next request plus one message", () => {
  const s = session();
  s.turnEnd(PRECOMPUTE_AT);
  s.turnEnd(PRECOMPUTE_AT + 1, "error");
  assert.equal(s.requests.length, 0);

  s.turnEnd(PRECOMPUTE_AT + 1);
  assert.equal(s.requests.length, 1);
  const { context, options } = s.requests[0];
  assert.deepEqual(context.messages.slice(0, -1), s.llmMessages);
  assert.equal(context.messages.at(-1).role, "user");
  assert.equal(context.messages.at(-1).content, INSTRUCTION);
  assert.equal(options.reasoning, "high");
  assert.equal(options.sessionId, "session-1");
  assert.equal(s.state.status, "compact: running");

  s.turnEnd(250_000);
  assert.equal(s.requests.length, 1);
});

test("follows Pi's per-model compaction settings", () => {
  const s = session();
  s.settings.compaction.modelOverrides = { "openai-codex/gpt": { reserveTokens: 22_000 } };
  s.turnEnd(200_000);
  assert.equal(s.requests.length, 0);
  s.turnEnd(200_001);
  assert.equal(s.requests.length, 1);

  const disabled = session();
  disabled.settings.compaction.enabled = false;
  disabled.turnEnd(271_000);
  assert.equal(disabled.requests.length, 0);
});

test("the threshold applies the ready summary instantly and keeps everything after it", async () => {
  const s = session();
  s.turnEnd(210_000);
  await s.reply("## Goal\nShip it");
  assert.equal(s.state.status, "compact: ready");

  s.state.branch.push({ id: "c" }, { id: "d" });
  const { compaction } = await s.compact();
  assert.equal(compaction.summary, "## Goal\nShip it\n\nFull transcript before this summary: /sessions/s.jsonl");
  assert.equal(compaction.firstKeptEntryId, "c");
  assert.equal(compaction.tokensBefore, 260_000);
  assert.deepEqual(compaction.usage, usage);
  assert.equal(compaction.details.throughEntryId, "b");
  assert.ok(compaction.details.waitedMs < 1_000);

  await s.handlers.session_compact({}, s.ctx);
  assert.equal(s.state.status, undefined);
  assert.equal(await s.compact({ reason: "overflow" }), undefined);
});

test("keeps nothing when the summary covers the whole context, and never repeats the transcript path", async () => {
  const s = session();
  s.turnEnd(210_000);
  await s.reply("Summary\n\nFull transcript before this summary: /sessions/s.jsonl");
  const { compaction } = await s.compact({ reason: "manual" });
  assert.equal(compaction.firstKeptEntryId, null);
  assert.equal(compaction.summary.match(/s\.jsonl/g)?.length, 1);
});

test("waits for a running summary; Esc stops waiting but keeps it running", async () => {
  const s = session();
  s.turnEnd(210_000);
  const esc = new AbortController();
  const waiting = s.compact({ signal: esc.signal });
  esc.abort();
  assert.equal(await waiting, undefined);
  assert.equal(s.requests[0].options.signal.aborted, false);

  const waitingAgain = s.compact();
  await s.reply("Summary");
  assert.match((await waitingAgain).compaction.summary, /^Summary/);
  assert.equal(s.requests.length, 1);
});

test("without a summary, writes one now, and falls back to Pi's compaction when that fails or the context overflowed", async () => {
  const s = session();
  s.turnEnd(100_000);
  assert.equal(await s.compact({ reason: "overflow" }), undefined);
  assert.equal(s.requests.length, 0);

  const waiting = s.compact({ reason: "manual" });
  assert.equal(s.requests.length, 1);
  await s.reply("", "error");
  assert.equal(await waiting, undefined);
  assert.match(s.state.notes[0], /Background compaction failed: rate limited/);
  assert.equal(s.state.status, undefined);
});

test("a focused /compact writes a fresh summary with that focus", async () => {
  const s = session();
  s.turnEnd(210_000);
  await s.reply("Background summary");

  const focused = s.compact({ reason: "manual", customInstructions: " the auth flow " });
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].context.messages.at(-1).content, `${INSTRUCTION}\n\nFocus the summary on: the auth flow`);
  await s.reply("Auth summary");
  assert.match((await focused).compaction.summary, /^Auth summary/);
});

test("tree navigation discards the summary until the next turn", async () => {
  const s = session();
  s.turnEnd(210_000);
  s.handlers.session_tree({}, s.ctx);
  assert.equal(s.requests[0].options.signal.aborted, true);
  assert.equal(s.state.status, undefined);
  assert.equal(await s.compact(), undefined);

  s.turnEnd(210_000);
  assert.equal(s.requests.length, 2);
});

const idle = (t: any) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const s = session();
  s.state.branch = [{ id: "a", type: "message", message: { role: "assistant" }, timestamp: new Date(0).toISOString() }];
  s.turnEnd(210_000);
  return s;
};

test("applies the summary when the idle prompt cache expires, after cache-warming refreshes", async (t) => {
  const s = idle(t);
  await s.reply("Summary");
  s.handlers.agent_settled({}, s.ctx);
  t.mock.timers.tick(270_000);
  s.state.branch.push({ id: "w", type: "usage", kind: "cache_warm", timestamp: new Date(270_000).toISOString() });
  t.mock.timers.tick(299_999);
  await flush();
  assert.equal(s.state.compactions, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(s.state.compactions, 1);
});

test("idle compaction waits for a running summary and skips busy sessions", async (t) => {
  const s = idle(t);
  s.handlers.agent_settled({}, s.ctx);
  t.mock.timers.tick(300_000);
  await flush();
  assert.equal(s.state.compactions, 0);
  await s.reply("Summary");
  assert.equal(s.state.compactions, 1);

  t.mock.timers.reset();
  const busy = idle(t);
  await busy.reply("Summary");
  busy.handlers.agent_settled({}, busy.ctx);
  busy.state.idle = false;
  t.mock.timers.tick(300_000);
  await flush();
  assert.equal(busy.state.compactions, 0);
});
