import assert from "node:assert/strict";
import test from "node:test";
import tinyCompact, {
  buildTinyCompaction,
  COMPACT_INSTRUCTION,
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
  assert.match(result.summary, /older compacted entries omitted/);
  assert.ok(result.details.omittedEntries > 0);
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

test("the extension only handles its marker and rejects command arguments", () => {
  let beforeCompact: ((event: any) => any) | undefined;
  let command: { handler: (args: string, ctx: any) => void } | undefined;
  const pi = {
    on(name: string, handler: (event: any) => any) {
      if (name === "session_before_compact") beforeCompact = handler;
    },
    registerCommand(name: string, value: typeof command) {
      assert.equal(name, "tiny-compact");
      command = value;
    },
  };
  tinyCompact(pi as never);

  const event = {
    customInstructions: undefined,
    signal: new AbortController().signal,
    preparation: preparation({ messagesToSummarize: [{ role: "user", content: "compact me" }] }),
    branchEntries: [],
  };
  assert.equal(beforeCompact?.(event), undefined);
  assert.ok(beforeCompact?.({ ...event, customInstructions: COMPACT_INSTRUCTION }).compaction);

  const notifications: string[] = [];
  const compactCalls: any[] = [];
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    compact: (options: unknown) => compactCalls.push(options),
  };
  command?.handler("focus on auth", ctx);
  assert.equal(compactCalls.length, 0);
  assert.match(notifications[0], /does not accept focus instructions/);

  command?.handler("", ctx);
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].customInstructions, COMPACT_INSTRUCTION);
});
