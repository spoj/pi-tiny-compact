import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi's built-in compaction defaults.
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const INSTRUCTION = `Summarize the conversation above for context compaction. Everything above will be replaced by your summary, and the work will continue from the summary alone.

Reply with only the summary: no tool calls, no further work, no preamble. The summary describes the work, so leave out this request and its rules.

If the conversation starts with an earlier compaction summary, carry forward what still matters, fold in what happened since, and drop what is obsolete.

Use these sections and omit empty ones:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Quote the user's instructions and preferences verbatim where wording matters. Preserve exact file paths, commands, identifiers, and error messages. Be concise.`;

interface Snapshot {
  leafId: string;
  messages: Message[];
}

interface Summary {
  text: string;
  usage: Usage;
}

interface Job {
  leafId: string;
  summary: Promise<Summary | undefined>;
  controller: AbortController;
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });

export default function tinyCompact(pi: ExtensionAPI) {
  let latest: Snapshot | undefined;
  let job: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Pi compacts above contextWindow - reserveTokens. Starting keepRecentTokens earlier leaves that much
  // conversation to keep verbatim, and that much time for the summary to finish.
  const precomputeAt = (ctx: ExtensionContext, contextWindow: number) => {
    const settings = pi.getSettings().compaction;
    if (settings?.enabled === false || !ctx.model) return Infinity;
    const override = settings?.modelOverrides?.[`${ctx.model.provider}/${ctx.model.id}`];
    const reserve = override?.reserveTokens ?? settings?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    const keep = override?.keepRecentTokens ?? settings?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    return contextWindow - reserve - keep;
  };

  // The agent's next request plus one user message, so the prompt cache covers all but that message.
  const summarize = async (
    ctx: ExtensionContext,
    snapshot: Snapshot,
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<Summary> => {
    const level = pi.getThinkingLevel();
    const instruction: Message = {
      role: "user",
      content: focus ? `${INSTRUCTION}\n\nFocus the summary on: ${focus}` : INSTRUCTION,
      timestamp: Date.now(),
    };
    const response = await ctx.modelRegistry
      .streamSimple(ctx.model!, { messages: [...snapshot.messages, instruction] }, {
        reasoning: level === "off" ? undefined : level,
        sessionId: ctx.sessionManager.getSessionId(),
        signal,
      })
      .result();
    const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    if (response.stopReason !== "stop" || !text) {
      throw new Error(response.errorMessage ?? `the model stopped with "${response.stopReason}"`);
    }
    return { text, usage: response.usage };
  };

  const start = (ctx: ExtensionContext, snapshot: Snapshot): Job => {
    const controller = new AbortController();
    const started: Job = {
      leafId: snapshot.leafId,
      controller,
      summary: summarize(ctx, snapshot, undefined, controller.signal).then(
        (summary) => {
          if (job === started) ctx.ui.setStatus("compact", "compact: ready");
          return summary;
        },
        (error: Error) => {
          if (job !== started) return undefined;
          job = undefined;
          ctx.ui.setStatus("compact", undefined);
          ctx.ui.notify(`Background compaction failed: ${error.message}`, "warning");
          return undefined;
        },
      ),
    };
    ctx.ui.setStatus("compact", "compact: running");
    return started;
  };

  const reset = (ctx: ExtensionContext) => {
    job?.controller.abort();
    job = undefined;
    latest = undefined;
    ctx.ui.setStatus("compact", undefined);
  };

  pi.on("turn_end", (event, ctx) => {
    if (event.outcome !== "completed") return;
    latest = { leafId: ctx.sessionManager.getLeafId()!, messages: event.context.llmMessages };
    const usage = ctx.getContextUsage();
    if (!job && usage?.tokens != null && usage.tokens > precomputeAt(ctx, usage.contextWindow)) job = start(ctx, latest);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const focus = event.customInstructions?.trim();
    const waitStart = Date.now();
    let throughEntryId: string;
    let summary: Summary | undefined;
    if (focus) {
      if (!latest) return;
      throughEntryId = latest.leafId;
      summary = await summarize(ctx, latest, focus, event.signal).catch(() => undefined);
    } else {
      // On overflow the latest snapshot may not fit either; only an earlier, running summary helps.
      if (!job && latest && event.reason !== "overflow") job = start(ctx, latest);
      if (!job) return;
      throughEntryId = job.leafId;
      // Esc stops waiting; the summary keeps running for the next attempt.
      summary = await Promise.race([job.summary, untilAborted(event.signal)]);
    }
    if (!summary) return;

    const index = event.branchEntries.findIndex((entry) => entry.id === throughEntryId);
    if (index < 0) return;
    const file = ctx.sessionManager.getSessionFile();
    return {
      compaction: {
        summary: file && !summary.text.includes(file)
          ? `${summary.text}\n\nFull transcript before this summary: ${file}`
          : summary.text,
        // null keeps nothing; Pi records the compaction's own id.
        firstKeptEntryId: (event.branchEntries[index + 1]?.id ?? null) as string,
        tokensBefore: event.preparation.tokensBefore,
        usage: summary.usage,
        details: { compactor: "pi-tiny-compact", throughEntryId, waitedMs: Date.now() - waitStart },
      },
    };
  });

  // The first request after the prompt cache expires re-caches the whole context, so apply the summary first.
  const applyWhenCacheExpires = (ctx: ExtensionContext) => {
    clearTimeout(timer);
    const pending = job;
    if (!pending) return;
    const lastCacheUse = ctx.sessionManager.getBranch().findLast((entry) =>
      (entry.type === "message" && entry.message.role === "assistant") ||
      (entry.type === "usage" && entry.kind === "cache_warm"));
    if (!lastCacheUse) return;
    const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    const ttl = ctx.model?.promptCache?.[retention] ?? DEFAULT_CACHE_TTL_SECONDS;
    const wait = Date.parse(lastCacheUse.timestamp) + ttl * 1000 - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => applyWhenCacheExpires(ctx), wait);
      timer.unref();
      return;
    }
    void pending.summary.then((summary) => {
      if (!summary || job !== pending || !ctx.isIdle()) return;
      ctx.compact({ onComplete: () => ctx.ui.notify("Compacted the idle session because its prompt cache expired", "info") });
    });
  };

  pi.on("agent_settled", (_event, ctx) => applyWhenCacheExpires(ctx));
  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimeout(timer);
    reset(ctx);
  });
}
