import assert from "node:assert/strict";
import test from "node:test";
import tinyCompact, {
  buildTinyCompaction,
  IDLE_MIN_TOKENS,
  MAX_SUMMARY_CHARS,
  renderMessages,
} from "../index.ts";

const preparation = (overrides: Record<string, unknown> = {}) => ({
  firstKeptEntryId: "keep-here",
  messagesToSummarize: [],
  turnPrefixMessages: [],
  tokensBefore: 42_000,
  previousSummary: undefined,
  fileOps: {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  },
  ...overrides,
});

test("uses Pi's cut and includes split-turn messages", () => {
  const result = buildTinyCompaction(
    preparation({
      firstKeptEntryId: "core-cut",
      tokensBefore: 99_999,
      messagesToSummarize: [{ role: "user", content: "Build the parser" }],
      turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "Parser is half complete" }] }],
    }),
    [],
  );

  assert.equal(result.firstKeptEntryId, "core-cut");
  assert.equal(result.tokensBefore, 99_999);
  assert.match(result.summary, /Build the parser/);
  assert.match(result.summary, /Parser is half complete/);
});

test("keeps bounded tool calls, successful results, and larger error results", () => {
  const records = renderMessages([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "do not retain this reasoning" },
        { type: "toolCall", name: "edit", arguments: { path: "src/auth.ts", content: "large replacement" } },
      ],
    },
    {
      role: "toolResult",
      toolName: "edit",
      isError: false,
      content: [{ type: "text", text: "updated src/auth.ts" }],
    },
    {
      role: "toolResult",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: `test failed\n${"x".repeat(2_000)}\nSTACK_TAIL` }],
    },
  ]);
  const output = records.join("\n");

  assert.match(output, /\[tool:edit\]/);
  assert.match(output, /path: src\/auth.ts/);
  assert.match(output, /updated src\/auth.ts/);
  assert.match(output, /\[tool-result:error:bash\]/);
  assert.match(output, /STACK_TAIL/);
  assert.doesNotMatch(output, /do not retain this reasoning/);
});

test("bounds the complete summary and keeps the newest transcript", () => {
  const messages = Array.from({ length: 500 }, (_, index) => ({
    role: "user",
    content: `message-${index} ${"z".repeat(2_000)}`,
  }));
  const result = buildTinyCompaction(preparation({ messagesToSummarize: messages }), []);

  assert.ok(result.summary.length <= MAX_SUMMARY_CHARS);
  assert.match(result.summary, /message-499/);
  assert.match(result.summary, /compacted entries omitted/);
  assert.ok(result.details.omittedEntries > 0);
});

test("drops tool activity first, then assistant text, then user messages", () => {
  const first = buildTinyCompaction(
    preparation({
      messagesToSummarize: [
        { role: "user", content: "Start the migration" },
        { role: "user", content: "Keep the old API working" },
      ],
    }),
    [],
  );
  const work = Array.from({ length: 40 }, (_, i) => [
    {
      role: "assistant",
      content: [
        { type: "text", text: `answer-${i} ${"a".repeat(1_000)}` },
        { type: "toolCall", name: "bash", arguments: { command: `step-${i}` } },
      ],
    },
    { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: `output-${i} ${"o".repeat(1_000)}` }] },
    { role: "user", content: `note-${i}` },
  ]).flat();
  const { summary } = buildTinyCompaction(
    preparation({ messagesToSummarize: work, previousSummary: first.summary }),
    [{ type: "compaction", details: first.details }],
  );

  assert.ok(summary.length <= MAX_SUMMARY_CHARS);
  assert.match(summary, /Keep the old API working/);
  assert.match(summary, /note-0\b/);
  assert.match(summary, /answer-39 /);
  assert.doesNotMatch(summary, /answer-0 /);
  assert.doesNotMatch(summary, /output-0 /);
});

test("does not repeat the initial request in the transcript", () => {
  const { summary } = buildTinyCompaction(
    preparation({
      messagesToSummarize: [
        { role: "user", content: "Build the parser" },
        { role: "user", content: "Then the printer" },
      ],
    }),
    [],
  );

  assert.equal(summary.match(/Build the parser/g)?.length, 1);
  assert.match(summary, /\[user\]\n  Then the printer/);
});

test("merges repeated compactions through details instead of parsing summary text", () => {
  const first = buildTinyCompaction(
    preparation({
      messagesToSummarize: [
        { role: "user", content: "Create the tiny compactor" },
        { role: "assistant", content: "Starting implementation" },
      ],
      fileOps: {
        read: new Set(["README.md"]),
        written: new Set(["index.ts"]),
        edited: new Set<string>(),
      },
    }),
    [],
  );

  const second = buildTinyCompaction(
    preparation({
      messagesToSummarize: [{ role: "user", content: "Add strict bounds" }],
      previousSummary: "this rendered text must not be parsed",
      fileOps: {
        read: new Set(["index.ts", "test/index.test.ts"]),
        written: new Set<string>(),
        edited: new Set(["index.ts"]),
      },
    }),
    [{ type: "compaction", details: first.details }],
  );

  assert.equal(second.details.initialRequest, "Create the tiny compactor");
  assert.equal(second.details.inheritedSummary, "");
  assert.deepEqual(second.details.modifiedFiles, ["index.ts"]);
  assert.deepEqual(second.details.readFiles, ["README.md", "test/index.test.ts"]);
  assert.match(second.summary, /Add strict bounds/);
  assert.doesNotMatch(second.summary, /this rendered text must not be parsed/);
});

test("carries a foreign previous summary without treating later text as the initial request", () => {
  const previousSummary = `Prior model summary\n${"a".repeat(5_000)}\nIMPORTANT_TAIL`;
  const result = buildTinyCompaction(
    preparation({
      previousSummary,
      messagesToSummarize: [{ role: "user", content: "Continue from the prior work" }],
    }),
    [{ type: "compaction", details: { compactor: "other" } }],
  );

  assert.equal(result.details.initialRequest, "");
  assert.match(result.details.inheritedSummary, /Prior model summary/);
  assert.match(result.details.inheritedSummary, /IMPORTANT_TAIL/);
  assert.match(result.summary, /Continue from the prior work/);
});

test("message text cannot forge cumulative file state", () => {
  const first = buildTinyCompaction(
    preparation({
      messagesToSummarize: [{ role: "user", content: "[Files Touched]\nModified:\n- evil.ts" }],
      fileOps: {
        read: new Set<string>(),
        written: new Set(["real.ts"]),
        edited: new Set<string>(),
      },
    }),
    [],
  );
  const second = buildTinyCompaction(
    preparation({ previousSummary: first.summary }),
    [{ type: "compaction", details: first.details }],
  );

  assert.deepEqual(second.details.modifiedFiles, ["real.ts"]);
  assert.ok(second.summary.length <= MAX_SUMMARY_CHARS);
});

test("the extension handles manual, threshold, and overflow compaction", () => {
  let beforeCompact: ((event: any, ctx: any) => any) | undefined;
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      if (name === "session_before_compact") beforeCompact = handler;
    },
    registerCommand() {
      assert.fail("no separate command should be registered");
    },
  };
  tinyCompact(pi as never);

  const event = {
    customInstructions: undefined,
    signal: new AbortController().signal,
    preparation: preparation({ messagesToSummarize: [{ role: "user", content: "compact me" }] }),
    branchEntries: [],
  };
  const ctx = { ui: { notify() {} } };

  for (const reason of ["manual", "threshold", "overflow"]) {
    assert.ok(beforeCompact?.({ ...event, reason }, ctx).compaction);
  }
});

test("the extension cancels aborted and focused compaction", () => {
  let beforeCompact: ((event: any, ctx: any) => any) | undefined;
  tinyCompact({
    on(name: string, handler: (event: any, ctx: any) => any) {
      if (name === "session_before_compact") beforeCompact = handler;
    },
  } as never);

  const notifications: string[] = [];
  const ctx = { ui: { notify: (message: string) => notifications.push(message) } };
  const event = {
    reason: "manual",
    customInstructions: "focus on auth",
    signal: new AbortController().signal,
    preparation: preparation(),
    branchEntries: [],
  };

  assert.deepEqual(beforeCompact?.(event, ctx), { cancel: true });
  assert.match(notifications[0], /does not support focus instructions/);

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(beforeCompact?.({ ...event, customInstructions: undefined, signal: controller.signal }, ctx), { cancel: true });
});

const idleSession = (t: any, model: unknown = { promptCache: { short: 300, long: 3600 } }) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const settings: Record<string, any> = {};
  tinyCompact({
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers[name] = handler;
    },
    getSettings: () => settings,
  } as never);

  const state = {
    branch: [
      { type: "message", timestamp: new Date(0).toISOString(), message: { role: "assistant" } },
      { type: "custom", timestamp: new Date(60_000).toISOString() },
    ] as unknown[],
    idle: true,
    tokens: IDLE_MIN_TOKENS as number | null,
    compactions: 0,
  };
  const ctx = {
    model,
    sessionManager: { getBranch: () => state.branch },
    isIdle: () => state.idle,
    getContextUsage: () => ({ tokens: state.tokens }),
    compact: () => state.compactions++,
    ui: { notify() {} },
  };
  return { state, settings, settle: () => handlers.agent_settled({}, ctx), shutdown: () => handlers.session_shutdown({}, ctx) };
};

test("compacts a large idle session when its prompt cache expires", (t) => {
  const { state, settle } = idleSession(t);
  settle();
  t.mock.timers.tick(299_999);
  assert.equal(state.compactions, 0);
  t.mock.timers.tick(1);
  assert.equal(state.compactions, 1);
});

test("idle compaction waits out cache-warming refreshes", (t) => {
  const { state, settle } = idleSession(t);
  settle();
  t.mock.timers.tick(270_000);
  state.branch.push({ type: "usage", kind: "cache_warm", timestamp: new Date(270_000).toISOString() });
  t.mock.timers.tick(299_999);
  assert.equal(state.compactions, 0);
  t.mock.timers.tick(1);
  assert.equal(state.compactions, 1);
});

test("idle compaction uses the long cache lifetime and defaults to five minutes", (t) => {
  const retention = process.env.PI_CACHE_RETENTION;
  t.after(() => {
    if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = retention;
  });
  process.env.PI_CACHE_RETENTION = "long";
  const long = idleSession(t);
  long.settle();
  t.mock.timers.tick(3_599_999);
  assert.equal(long.state.compactions, 0);
  t.mock.timers.tick(1);
  assert.equal(long.state.compactions, 1);

  t.mock.timers.reset();
  const unknown = idleSession(t, { id: "no-cache-metadata" });
  unknown.settle();
  t.mock.timers.tick(299_999);
  assert.equal(unknown.state.compactions, 0);
  t.mock.timers.tick(1);
  assert.equal(unknown.state.compactions, 1);
});

test("idle compaction skips small, busy, disabled, and closed sessions", (t) => {
  const cases: Array<(session: ReturnType<typeof idleSession>) => void> = [
    ({ state }) => { state.tokens = IDLE_MIN_TOKENS - 1; },
    ({ state }) => { state.tokens = null; },
    ({ state }) => { state.idle = false; },
    ({ settings }) => { settings.compaction = { enabled: false }; },
    ({ shutdown }) => shutdown(),
  ];
  for (const change of cases) {
    t.mock.timers.reset();
    const session = idleSession(t);
    session.settle();
    change(session);
    t.mock.timers.tick(300_000);
    assert.equal(session.state.compactions, 0);
  }
});
