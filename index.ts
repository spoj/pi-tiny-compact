import { retryAssistantCall, type Message, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, DEFAULT_COMPACTION_SETTINGS, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi's built-in retry defaults.
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;

export const INSTRUCTION = `Summarize the conversation above for context compaction.

Start the summary with a title line, \`# <title>\`, that names in a few words what the conversation is about now.

Reply with only the summary: no tool calls, no further work, no preamble, nothing about this request or its rules.

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

interface Summary {
  text: string;
  usage: Usage;
  firstKeptEntryId: string;
}

interface Job {
  summary: Promise<Summary | undefined>;
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
    const reserve = override?.reserveTokens ?? settings?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
    const keep = override?.keepRecentTokens ?? settings?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
    return contextWindow - reserve - keep;
  };

  // The last model request's input plus one user message, with the agent's model and thinking level: the prompt
  // cache covers all but that message, and the request fits the context window because the last one did.
  // The last response stays verbatim.
  const summarize = async (ctx: ExtensionContext, focus: string | undefined, signal: AbortSignal): Promise<Summary> => {
    const { entries } = ctx.sessionManager.buildSessionProjection();
    const cut = entries.findLastIndex((entry) => entry.messages.some((message) => message.role === "assistant"));
    if (cut < 0) throw new Error("there is no model response to summarize up to");
    const content = focus ? `${INSTRUCTION}\n\nFocus the summary on: ${focus}` : INSTRUCTION;
    const messages: Message[] = [
      ...convertToLlm(entries.slice(0, cut).flatMap((entry) => entry.messages)),
      { role: "user", content, timestamp: Date.now() },
    ];
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
    return { text, usage: response.usage, firstKeptEntryId: entries[cut].sourceEntry.id };
  };

  // Best effort: when this fails, compaction writes the summary itself.
  const start = (ctx: ExtensionContext): Job => {
    const controller = new AbortController();
    const started: Job = {
      controller,
      summary: summarize(ctx, undefined, controller.signal).then(
        (summary) => {
          if (job === started) ctx.ui.setStatus("compact", "compact:ready");
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
    ctx.ui.setStatus("compact", "compact:running");
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
      summary = await summarize(ctx, focus, event.signal).catch((error: Error) => {
        if (!event.signal.aborted) ctx.ui.notify(`Compaction failed: ${error.message}`, "warning");
        return undefined;
      });
    }
    if (!summary) return { cancel: true };

    // Rename only a session with no name or the name this extension set last, never one the user set.
    // Its compaction entries, on any branch, record the names it sets, so this survives restarts.
    const title = summary.text.match(/^# (.+)/)?.[1].trim();
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

  // The first request after the prompt cache expires re-caches the whole context, so apply the summary first.
  const applyWhenCacheExpires = (ctx: ExtensionContext) => {
    clearTimeout(timer);
    const pending = job;
    if (!pending) return;
    const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    const ttl = ctx.model?.promptCache?.[retention];
    if (ttl === undefined) return;
    const lastCacheUse = ctx.sessionManager.getBranch().findLast((entry) =>
      (entry.type === "message" && entry.message.role === "assistant") ||
      (entry.type === "usage" && entry.kind === "cache_warm"));
    if (!lastCacheUse) return;
    // As Pi's cache warming does: a response from when its request was sent, a refresh from when it finished.
    const usedAt = lastCacheUse.type === "message" ? lastCacheUse.message.timestamp : Date.parse(lastCacheUse.timestamp);
    const wait = usedAt + ttl * 1000 - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => applyWhenCacheExpires(ctx), wait);
      timer.unref();
      return;
    }
    void pending.summary.then((summary) => {
      if (!summary || job !== pending || !ctx.isIdle() || pi.getSettings().compaction?.enabled === false) return;
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
