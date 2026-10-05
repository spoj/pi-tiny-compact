import { retryAssistantCall, type Message, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi's built-in defaults.
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_CACHE_TTL_SECONDS = 300;

const RULES = `Reply with only the summary: no tool calls, no further work, no preamble. The summary describes the work, so leave out this request and its rules.

If what you summarize includes an earlier summary, carry forward what still matters, fold in what happened since, and drop what is obsolete.

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

export const INSTRUCTION = `Summarize the conversation above for context compaction. Everything above will be replaced by your summary, and the work will continue from the summary alone.

Start the summary with a title line, \`# <title>\`, that names in a few words what the conversation is about now.

${RULES}`;

export const branchInstruction = (opening: string) => `Summarize the branch of the conversation from the message that starts «${opening}» to the end. The user is leaving this branch, and your summary will replace it; the conversation before that message stays. Leaving the branch does not undo its changes to files or other state, so record them.

${RULES}`;

interface Summary {
  text: string;
  usage: Usage;
}

interface CompactionSummary extends Summary {
  firstKeptEntryId: string;
}

interface Job {
  summary: Promise<CompactionSummary | undefined>;
  controller: AbortController;
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });

export default function tinyCompact(pi: ExtensionAPI) {
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

  // The context plus one user message, with the agent's model and thinking level: the prompt cache covers
  // the context up to what the agent last sent.
  const summarize = async (
    ctx: ExtensionContext,
    context: Message[],
    instruction: string,
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<Summary> => {
    const content = focus ? `${instruction}\n\nFocus the summary on: ${focus}` : instruction;
    const messages: Message[] = [...context, { role: "user", content, timestamp: Date.now() }];
    const level = pi.getThinkingLevel();
    const retry = pi.getSettings().retry;
    const response = await retryAssistantCall(
      () => ctx.modelRegistry
        .streamSimple(ctx.model!, { messages }, {
          reasoning: level === "off" ? undefined : level,
          sessionId: ctx.sessionManager.getSessionId(),
          signal,
        })
        .result(),
      {
        enabled: retry?.enabled ?? true,
        maxRetries: retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
        baseDelayMs: retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
        maxAgentDelayMs: retry?.maxAgentDelayMs,
      },
      signal,
    );
    const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    if (response.stopReason !== "stop" || !text) {
      throw new Error(response.errorMessage ?? `the model stopped with "${response.stopReason}"`);
    }
    return { text, usage: response.usage };
  };

  // The last model request's input, which fits the context window because it already did.
  // The last response stays verbatim.
  const compactionSummary = async (
    ctx: ExtensionContext,
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<CompactionSummary> => {
    const { entries } = ctx.sessionManager.buildSessionProjection();
    const cut = entries.findLastIndex((entry) => entry.messages.some((message) => message.role === "assistant"));
    if (cut < 0) throw new Error("there is no model response to summarize up to");
    const context = convertToLlm(entries.slice(0, cut).flatMap((entry) => entry.messages));
    return { ...(await summarize(ctx, context, INSTRUCTION, focus, signal)), firstKeptEntryId: entries[cut].sourceEntry.id };
  };

  // Best effort: when this fails, compaction writes the summary itself.
  const start = (ctx: ExtensionContext): Job => {
    const controller = new AbortController();
    const started: Job = {
      controller,
      summary: compactionSummary(ctx, undefined, controller.signal).then(
        (summary) => {
          if (job === started) ctx.ui.setStatus("compact", "compact: ready");
          return summary;
        },
        () => {
          if (job !== started) return undefined;
          job = undefined;
          ctx.ui.setStatus("compact", undefined);
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
    ctx.ui.setStatus("compact", undefined);
  };

  pi.on("turn_end", (event, ctx) => {
    if (event.outcome !== "completed" || job) return;
    const usage = ctx.getContextUsage();
    if (usage?.tokens != null && usage.tokens > precomputeAt(ctx, usage.contextWindow)) job = start(ctx);
  });

  // Every compaction is written here; returning nothing would run Pi's own.
  pi.on("session_before_compact", async (event, ctx) => {
    const focus = event.customInstructions?.trim();
    const waitStart = Date.now();
    // Esc stops waiting; the background summary keeps running for the next attempt.
    let summary = job && !focus ? await Promise.race([job.summary, untilAborted(event.signal)]) : undefined;
    if (!summary && !event.signal.aborted) {
      summary = await compactionSummary(ctx, focus, event.signal).catch((error: Error) => {
        if (!event.signal.aborted) ctx.ui.notify(`Compaction failed: ${error.message}`, "warning");
        return undefined;
      });
    }
    if (!summary) return { cancel: true };

    // Rename only a session with no name or the name this extension set last, never one the user set.
    // Its compaction entries, on any branch, record the names it sets, so this survives restarts.
    const title = summary.text.match(/^# (.+)/m)?.[1].trim();
    const name = ctx.sessionManager.getSessionName();
    const lastSet = ctx.sessionManager.getEntries()
      .map((entry) => entry.type === "compaction" && (entry.details as { sessionName?: string } | undefined)?.sessionName)
      .findLast(Boolean);
    const file = ctx.sessionManager.getSessionFile();
    const pointer = `Full transcript before this summary: ${file}`;
    return {
      compaction: {
        summary: file && !summary.text.includes(pointer) ? `${summary.text}\n\n${pointer}` : summary.text,
        firstKeptEntryId: summary.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: summary.usage,
        details: {
          compactor: "pi-tiny-compact",
          waitedMs: Date.now() - waitStart,
          sessionName: title && (!name || name === lastSet) ? title : undefined,
        },
      },
    };
  });

  // Pi asks before it leaves the branch, so the context is still the branch's: the summary request is all of it
  // plus one message quoting where the branch starts. When a summary is wanted, returning nothing would run Pi's own.
  pi.on("session_before_tree", async (event, ctx) => {
    const { preparation, signal } = event;
    if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) return;
    try {
      const leaving = new Set(preparation.entriesToSummarize.map((entry) => entry.id));
      const target = ctx.sessionManager.getEntry(preparation.targetId)!;
      // Pi puts a selected user message back in the editor, so it leaves the context too.
      if (target.type === "custom_message" || (target.type === "message" && target.message.role === "user")) {
        leaving.add(target.id);
      }
      const { entries } = ctx.sessionManager.buildSessionProjection();
      let cut = entries.length;
      while (cut > 0 && leaving.has(entries[cut - 1].sourceEntry.id)) cut--;
      const first = convertToLlm(entries.slice(cut).flatMap((entry) => entry.messages))
        .find((message) => message.role !== "system");
      if (!first) throw new Error("the branch has no messages to summarize");
      const opening = typeof first.content === "string" ? first.content : first.content.map((part) =>
        part.type === "text" ? part.text : part.type === "toolCall" ? `${part.name}(${JSON.stringify(part.arguments)})` : "").join("");
      const context = convertToLlm(entries.flatMap((entry) => entry.messages));
      const focus = preparation.customInstructions?.trim();
      const summary = await summarize(ctx, context, branchInstruction(opening.slice(0, 200)), focus, signal);
      const file = ctx.sessionManager.getSessionFile();
      return {
        summary: {
          summary: file
            ? `${summary.text}\n\nFull transcript of this branch: ${file}, ending at entry ${preparation.oldLeafId}`
            : summary.text,
          usage: summary.usage,
          details: { compactor: "pi-tiny-compact" },
        },
      };
    } catch (error) {
      if (!signal.aborted) ctx.ui.notify(`Branch summary failed: ${(error as Error).message}`, "warning");
      return { cancel: true };
    }
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
  // Rename once Pi has saved the compaction, so every name this extension sets is on record.
  pi.on("session_compact", (event, ctx) => {
    reset(ctx);
    const name = (event.compactionEntry.details as { sessionName?: string } | undefined)?.sessionName;
    if (name) pi.setSessionName(name);
  });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimeout(timer);
    reset(ctx);
  });
}
