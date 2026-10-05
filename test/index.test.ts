import assert from "node:assert/strict";
import test from "node:test";
import tinyCompact, { branchInstruction, INSTRUCTION } from "../index.ts";

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
// codex: 272,000 window - 16,384 default reserve - 50,000 keepRecentTokens
const PRECOMPUTE_AT = 205_616;

const entry = (id: string, role: string, content: unknown = id) => ({
  sourceEntry: { id, type: "message", message: { role } },
  messages: [{ role, content, timestamp: 0 }],
});
// The last model request: everything before its response, a2.
const lastRequest = [entry("s", "system"), entry("u", "user"), entry("a1", "assistant"), entry("r1", "toolResult")];

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
    entries: [...lastRequest, entry("a2", "assistant"), entry("r2", "toolResult")] as any[],
    branch: [] as any[],
    idle: true,
    status: undefined as string | undefined,
    notes: [] as string[],
    compactions: 0,
  };
  const ctx = {
    model: { provider: "openai-codex", id: "gpt", promptCache: { short: 300, long: 3600 } },
    sessionManager: {
      buildSessionProjection: () => ({ entries: state.entries }),
      getEntry: (id: string) => state.entries.find((entry) => entry.sourceEntry.id === id).sourceEntry,
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

  return {
    handlers, settings, state, ctx, requests,
    turnEnd: (tokens: number, outcome = "completed") => {
      state.tokens = tokens;
      handlers.turn_end({ outcome }, ctx);
    },
    compact: (event: Record<string, unknown> = {}) => handlers.session_before_compact({
      reason: "threshold",
      signal: new AbortController().signal,
      preparation: { tokensBefore: 260_000 },
      ...event,
    }, ctx),
    leave: (targetId: string, leaving: string[], preparation: Record<string, unknown> = {}, signal = new AbortController().signal) =>
      handlers.session_before_tree({
        preparation: {
          targetId,
          oldLeafId: leaving.at(-1),
          entriesToSummarize: leaving.map((id) => ({ id })),
          userWantsSummary: true,
          ...preparation,
        },
        signal,
      }, ctx),
    reply: async (text: string, stopReason = "stop", errorMessage?: string) => {
      requests.at(-1)!.finish({ content: [{ type: "text", text }], stopReason, usage, errorMessage });
      await flush();
    },
  };
};

test("starts keepRecentTokens before Pi's threshold, as the last model request plus one message", () => {
  const s = session();
  s.turnEnd(PRECOMPUTE_AT);
  s.turnEnd(PRECOMPUTE_AT + 1, "error");
  assert.equal(s.requests.length, 0);

  s.turnEnd(PRECOMPUTE_AT + 1);
  assert.equal(s.requests.length, 1);
  const { context, options } = s.requests[0];
  assert.deepEqual(context.messages.slice(0, -1), lastRequest.flatMap((entry) => entry.messages));
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

test("the threshold applies the ready summary instantly and keeps everything from the last response it saw", async () => {
  const s = session();
  s.turnEnd(210_000);
  await s.reply("## Goal\nShip it");
  assert.equal(s.state.status, "compact: ready");

  s.state.entries.push(entry("a3", "assistant"), entry("r3", "toolResult"));
  const { compaction } = await s.compact();
  assert.equal(s.requests.length, 1);
  assert.equal(compaction.summary, "## Goal\nShip it\n\nFull transcript before this summary: /sessions/s.jsonl");
  assert.equal(compaction.firstKeptEntryId, "a2");
  assert.equal(compaction.tokensBefore, 260_000);
  assert.deepEqual(compaction.usage, usage);
  assert.equal(compaction.details.compactor, "pi-tiny-compact");
  assert.ok(compaction.details.waitedMs < 1_000);

  await s.handlers.session_compact({}, s.ctx);
  assert.equal(s.state.status, undefined);
});

test("without a background summary, writes one now the same way, which fits even after an overflow", async () => {
  const s = session();
  s.turnEnd(100_000);
  const compacting = s.compact({ reason: "overflow" });
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0].context.messages.slice(0, -1), lastRequest.flatMap((entry) => entry.messages));

  await s.reply("Summary\n\nFull transcript before this summary: /sessions/s.jsonl");
  const { compaction } = await compacting;
  assert.equal(compaction.firstKeptEntryId, "a2");
  assert.equal(compaction.summary.match(/s\.jsonl/g)?.length, 1);
});

test("a failed background summary is dropped quietly, and compaction writes its own", async () => {
  const s = session();
  s.turnEnd(210_000);
  await s.reply("", "error", "invalid request");
  assert.equal(s.state.status, undefined);
  assert.deepEqual(s.state.notes, []);

  const compacting = s.compact();
  assert.equal(s.requests.length, 2);
  await s.reply("Summary");
  assert.match((await compacting).compaction.summary, /^Summary/);
});

test("retries per Pi's retry settings, then cancels with a warning instead of running Pi's compaction", async () => {
  const s = session();
  s.settings.retry = { maxRetries: 1, baseDelayMs: 1 };
  const compacting = s.compact({ reason: "manual" });
  await s.reply("", "error", "rate limited");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.requests.length, 2);
  await s.reply("", "error", "rate limited");
  assert.deepEqual(await compacting, { cancel: true });
  assert.deepEqual(s.state.notes, ["Compaction failed: rate limited"]);

  s.state.entries = [entry("s", "system"), entry("u", "user")];
  assert.deepEqual(await s.compact({ reason: "overflow" }), { cancel: true });
  assert.equal(s.requests.length, 2);
  assert.equal(s.state.notes[1], "Compaction failed: there is no model response to summarize up to");
});

test("waits for a running summary; Esc stops waiting but keeps it running", async () => {
  const s = session();
  s.turnEnd(210_000);
  const esc = new AbortController();
  const waiting = s.compact({ signal: esc.signal });
  esc.abort();
  assert.deepEqual(await waiting, { cancel: true });
  assert.equal(s.requests[0].options.signal.aborted, false);
  assert.deepEqual(s.state.notes, []);

  const waitingAgain = s.compact();
  await s.reply("Summary");
  assert.match((await waitingAgain).compaction.summary, /^Summary/);
  assert.equal(s.requests.length, 1);
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

test("tree navigation discards the background summary until the next turn", () => {
  const s = session();
  s.turnEnd(210_000);
  s.handlers.session_tree({}, s.ctx);
  assert.equal(s.requests[0].options.signal.aborted, true);
  assert.equal(s.state.status, undefined);

  s.turnEnd(210_000);
  assert.equal(s.requests.length, 2);
});

const call = (id: string, command: string) =>
  entry(id, "assistant", [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id, name: "bash", arguments: { command } }]);
const branch = () => [
  entry("s", "system"), entry("u1", "user"), entry("a1", "assistant"),
  entry("s2", "system"), entry("u2", "user"), call("c1", "ls"), entry("r1", "toolResult"),
  call("c2", "pwd"), entry("r2", "toolResult"), entry("a2", "assistant"),
];

test("a branch summary resends the whole branch with one message quoting where the branch starts", async () => {
  const s = session();
  s.state.entries = branch();
  const leaving = s.leave("a1", ["s2", "u2", "c1", "r1", "c2", "r2", "a2"]);
  const { context, options } = s.requests[0];
  assert.deepEqual(context.messages.slice(0, -1), branch().flatMap((entry) => entry.messages));
  assert.equal(context.messages.at(-1).content, branchInstruction("u2"));
  assert.equal(options.reasoning, "high");

  await s.reply("## Goal\nTry Redis");
  assert.deepEqual(await leaving, {
    summary: {
      summary: "## Goal\nTry Redis\n\nFull transcript of this branch: /sessions/s.jsonl, ending at entry a2",
      usage,
      details: { compactor: "pi-tiny-compact" },
    },
  });
});

test("a selected user message leaves with its branch, and a branch can start with a tool call", () => {
  const s = session();
  s.state.entries = branch();
  s.leave("u2", ["c1", "r1", "c2", "r2", "a2"]);
  s.leave("r1", ["c2", "r2", "a2"], { customInstructions: " the pwd " });
  assert.equal(s.requests[0].context.messages.at(-1).content, branchInstruction("u2"));
  assert.equal(
    s.requests[1].context.messages.at(-1).content,
    `${branchInstruction('bash({"command":"pwd"})')}\n\nFocus the summary on: the pwd`,
  );
});

test("leaves without a summary unless asked, and cancels with a warning instead of running Pi's", async () => {
  const s = session();
  s.state.entries = branch();
  assert.equal(await s.leave("a1", ["s2", "u2"], { userWantsSummary: false }), undefined);
  assert.equal(await s.leave("a2", []), undefined);

  s.settings.retry = { enabled: false };
  const failing = s.leave("a1", ["s2", "u2", "c1", "r1", "c2", "r2", "a2"]);
  await s.reply("", "error", "invalid request");
  assert.deepEqual(await failing, { cancel: true });
  assert.deepEqual(s.state.notes, ["Branch summary failed: invalid request"]);

  const esc = new AbortController();
  const escaped = s.leave("a1", ["s2", "u2", "c1", "r1", "c2", "r2", "a2"], {}, esc.signal);
  esc.abort();
  await s.reply("", "aborted");
  assert.deepEqual(await escaped, { cancel: true });
  assert.equal(s.state.notes.length, 1);

  s.state.entries.push({ sourceEntry: { id: "m", type: "model_change" }, messages: [] } as any);
  assert.deepEqual(await s.leave("a2", ["m"]), { cancel: true });
  assert.equal(s.state.notes[1], "Branch summary failed: the branch has no messages to summarize");
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
