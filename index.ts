import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_SUMMARY_CHARS = 32_000;
export const IDLE_MIN_TOKENS = 100_000;
const DEFAULT_CACHE_TTL_SECONDS = 300;

const LIMIT = {
  initial: 1_200,
  inherited: 3_000,
  message: 1_200,
  tool: 500,
  result: 600,
  error: 1_200,
  path: 240,
  paths: 50,
  pathSection: 1_500,
};

interface Preparation {
  firstKeptEntryId: string;
  messagesToSummarize: readonly unknown[];
  turnPrefixMessages: readonly unknown[];
  tokensBefore: number;
  previousSummary?: string;
  fileOps: {
    read: Iterable<string>;
    written: Iterable<string>;
    edited: Iterable<string>;
  };
}

export interface TinyCompactDetails {
  compactor: "pi-tiny-compact";
  version: 1;
  initialRequest: string;
  inheritedSummary: string;
  transcript: string[];
  omittedEntries: number;
  readFiles: string[];
  modifiedFiles: string[];
}

const recordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clean = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const clip = (text: string, max: number): string => {
  const value = clean(text);
  if (value.length <= max) return value;
  const marker = "\n…[truncated]…\n";
  const room = max - marker.length;
  const head = Math.ceil(room / 2);
  return value.slice(0, head) + marker + value.slice(-(room - head));
};

const label = (value: unknown): string =>
  (typeof value === "string" ? value : "unknown")
    .replace(/[^\p{L}\p{N}_.:-]+/gu, "_")
    .slice(0, 60) || "unknown";

const block = (name: string, body: string, max: number): string => {
  const value = clip(body, max);
  if (!value) return "";
  return `[${label(name)}]\n${value.split("\n").map((line) => `  ${line}`).join("\n")}`;
};

const contentText = (content: unknown): string => {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  return clean(content.flatMap((part) => {
    if (!recordLike(part)) return [];
    if (part.type === "text" && typeof part.text === "string") return [part.text];
    if (part.type === "image") return [`[image: ${typeof part.mimeType === "string" ? part.mimeType : "unknown"}]`];
    return [];
  }).join("\n"));
};

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const toolArguments = (value: unknown): string => {
  if (!recordLike(value)) return json(value);
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof value[key] === "string") return `path: ${value[key]}`;
  }
  if (typeof value.command === "string") return `command: ${value.command}`;
  if (typeof value.query === "string") return `query: ${value.query}`;
  return json(value);
};

export const renderMessages = (messages: readonly unknown[]): string[] => {
  const output: string[] = [];
  const add = (name: string, body: string, max: number) => {
    const value = block(name, body, max);
    if (value) output.push(value);
  };

  for (const raw of messages) {
    if (!recordLike(raw) || typeof raw.role !== "string") continue;

    if (raw.role === "user") add("user", contentText(raw.content), LIMIT.message);

    if (raw.role === "assistant") {
      if (typeof raw.content === "string") add("assistant", raw.content, LIMIT.message);
      if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
          if (!recordLike(part)) continue;
          if (part.type === "text" && typeof part.text === "string") add("assistant", part.text, LIMIT.message);
          if (part.type === "toolCall") {
            add(`tool:${label(part.name)}`, toolArguments(part.arguments) || "(no arguments)", LIMIT.tool);
          }
        }
      }
    }

    if (raw.role === "toolResult") {
      const failed = raw.isError === true;
      add(
        failed ? `tool-result:error:${label(raw.toolName)}` : `tool-result:${label(raw.toolName)}`,
        contentText(raw.content),
        failed ? LIMIT.error : LIMIT.result,
      );
    }

    if (raw.role === "bashExecution") {
      const failed = raw.exitCode !== 0;
      const command = typeof raw.command === "string" ? `$ ${raw.command}` : "";
      const result = typeof raw.output === "string" ? raw.output : "";
      add(failed ? `bash:error:${raw.exitCode ?? "unknown"}` : "bash", [command, result].filter(Boolean).join("\n"), failed ? LIMIT.error : LIMIT.result);
    }

    if (raw.role === "custom") add(`context:${label(raw.customType)}`, contentText(raw.content), LIMIT.message);
    if (raw.role === "branchSummary" && typeof raw.summary === "string") add("branch-summary", raw.summary, LIMIT.message);
  }
  return output;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const previousDetails = (entries: readonly unknown[]): TinyCompactDetails | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!recordLike(entry) || entry.type !== "compaction") continue;
    const value = entry.details;
    if (!recordLike(value) || value.compactor !== "pi-tiny-compact" || value.version !== 1) return;
    return {
      compactor: "pi-tiny-compact",
      version: 1,
      initialRequest: clip(typeof value.initialRequest === "string" ? value.initialRequest : "", LIMIT.initial),
      inheritedSummary: clip(typeof value.inheritedSummary === "string" ? value.inheritedSummary : "", LIMIT.inherited),
      transcript: strings(value.transcript).map((item) => clip(item, 1_500)),
      omittedEntries: typeof value.omittedEntries === "number" && Number.isSafeInteger(value.omittedEntries)
        ? Math.max(0, value.omittedEntries)
        : 0,
      readFiles: strings(value.readFiles).slice(-LIMIT.paths),
      modifiedFiles: strings(value.modifiedFiles).slice(-LIMIT.paths),
    };
  }
};

const path = (value: string): string => {
  const oneLine = clean(value).replace(/\s+/g, " ");
  if (oneLine.length <= LIMIT.path) return oneLine;
  const half = Math.floor((LIMIT.path - 1) / 2);
  return `${oneLine.slice(0, half)}…${oneLine.slice(-half)}`;
};

const mergePaths = (old: readonly string[], fresh: Iterable<string>): string[] => {
  const merged: string[] = [];
  for (const raw of [...old, ...fresh]) {
    if (typeof raw !== "string") continue;
    const value = path(raw);
    if (!value) continue;
    const duplicate = merged.indexOf(value);
    if (duplicate >= 0) merged.splice(duplicate, 1);
    merged.push(value);
  }
  return merged.slice(-LIMIT.paths);
};

const renderPaths = (paths: readonly string[]): string => {
  const lines: string[] = [];
  let size = 0;
  for (let i = paths.length - 1; i >= 0; i--) {
    const line = `- ${paths[i]}`;
    if (size + line.length + 1 > LIMIT.pathSection) break;
    lines.push(line);
    size += line.length + 1;
  }
  lines.reverse();
  const omitted = paths.length - lines.length;
  if (omitted) lines.unshift(`- … ${omitted} older paths omitted`);
  return lines.join("\n");
};

export const renderSummary = (details: TinyCompactDetails): string => {
  const sections: string[] = [];
  const indent = (value: string) => value.split("\n").map((line) => `  ${line}`).join("\n");

  if (details.initialRequest) sections.push(`[Initial Request]\n${indent(details.initialRequest)}`);
  if (details.inheritedSummary) sections.push(`[Inherited Summary]\n${indent(details.inheritedSummary)}`);

  const files: string[] = [];
  if (details.modifiedFiles.length) files.push(`Modified:\n${renderPaths(details.modifiedFiles)}`);
  if (details.readFiles.length) files.push(`Read:\n${renderPaths(details.readFiles)}`);
  if (files.length) sections.push(`[Files Touched]\n${files.join("\n\n")}`);

  const transcript = [...details.transcript];
  if (details.omittedEntries) transcript.unshift(`(${details.omittedEntries} compacted entries omitted)`);
  sections.push(`[Compacted Transcript]\n${transcript.join("\n\n") || "(no textual entries)"}`);
  return sections.join("\n\n");
};

const isUserText = (raw: unknown): raw is Record<string, unknown> =>
  recordLike(raw) && raw.role === "user" && contentText(raw.content) !== "";

// Every record starts with its generated header; message text is indented beneath it.
const priority = (record: string): number =>
  record.startsWith("[user]") ? 0 : /^\[(assistant|branch-summary)\]/.test(record) ? 1 : 2;

const fit = (
  base: Omit<TinyCompactDetails, "transcript" | "omittedEntries">,
  records: readonly string[],
  alreadyOmitted: number,
): TinyCompactDetails => {
  const kept = new Set<number>();
  const details = (): TinyCompactDetails => {
    const transcript = records.filter((_, i) => kept.has(i));
    return { ...base, transcript, omittedEntries: alreadyOmitted + records.length - transcript.length };
  };
  for (const level of [0, 1, 2]) {
    for (let i = records.length - 1; i >= 0; i--) {
      if (priority(records[i]) !== level) continue;
      kept.add(i);
      if (renderSummary(details()).length <= MAX_SUMMARY_CHARS) continue;
      kept.delete(i);
      break;
    }
  }
  return details();
};

export const buildTinyCompaction = (preparation: Preparation, entries: readonly unknown[]) => {
  const previous = previousDetails(entries);
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const initial = previous || preparation.previousSummary ? undefined : messages.find(isUserText);
  const modifiedFiles = mergePaths(previous?.modifiedFiles ?? [], [...preparation.fileOps.written, ...preparation.fileOps.edited]);
  const modified = new Set(modifiedFiles);
  const readFiles = mergePaths(previous?.readFiles ?? [], preparation.fileOps.read).filter((item) => !modified.has(item));
  const base: Omit<TinyCompactDetails, "transcript" | "omittedEntries"> = {
    compactor: "pi-tiny-compact",
    version: 1,
    initialRequest: previous?.initialRequest ?? (initial ? clip(contentText(initial.content), LIMIT.initial) : ""),
    inheritedSummary: previous?.inheritedSummary ?? clip(preparation.previousSummary ?? "", LIMIT.inherited),
    readFiles,
    modifiedFiles,
  };
  const records = renderMessages(messages.filter((message) => message !== initial));
  const details = fit(base, [...(previous?.transcript ?? []), ...records], previous?.omittedEntries ?? 0);
  return {
    summary: renderSummary(details),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details,
  };
};

export default function tinyCompact(pi: ExtensionAPI) {
  pi.on("session_before_compact", (event, ctx) => {
    if (event.signal.aborted) return { cancel: true };
    if (event.customInstructions?.trim()) {
      ctx.ui.notify("pi-tiny-compact does not support focus instructions", "warning");
      return { cancel: true };
    }
    return { compaction: buildTinyCompaction(event.preparation, event.branchEntries) };
  });

  // The first request after the prompt cache expires re-caches the whole context, so shrink it first.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const compactWhenCacheExpires = (ctx: ExtensionContext) => {
    clearTimeout(timer);
    const lastCacheUse = ctx.sessionManager.getBranch().findLast((entry) =>
      (entry.type === "message" && entry.message.role === "assistant") ||
      (entry.type === "usage" && entry.kind === "cache_warm"));
    if (!lastCacheUse) return;
    const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    const ttl = ctx.model?.promptCache?.[retention] ?? DEFAULT_CACHE_TTL_SECONDS;
    const wait = Date.parse(lastCacheUse.timestamp) + ttl * 1000 - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => compactWhenCacheExpires(ctx), wait);
      timer.unref();
      return;
    }
    if (!ctx.isIdle() || pi.getSettings().compaction?.enabled === false) return;
    if ((ctx.getContextUsage()?.tokens ?? 0) < IDLE_MIN_TOKENS) return;
    ctx.compact({ onComplete: () => ctx.ui.notify("Compacted the idle session because its prompt cache expired", "info") });
  };
  pi.on("agent_settled", (_event, ctx) => compactWhenCacheExpires(ctx));
  pi.on("session_shutdown", () => clearTimeout(timer));
}
