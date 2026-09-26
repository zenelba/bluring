/** In-memory journal for the active tool session (from mode/task select). */

export type JournalToolId =
  | "home"
  | "blur"
  | "foveal"
  | "saliency"
  | "report"
  | "portraits"
  | "collages"
  | "av"
  | "brandRemoval"
  | "textReplace";

export type JournalEvent = {
  /** ms since session start */
  t: number;
  type: string;
  detail?: string;
};

export type JournalSnapshot = {
  sessionId: string;
  toolId: JournalToolId;
  taskId: string | null;
  title: string | null;
  startedAt: number;
  events: JournalEvent[];
};

const MAX_EVENTS = 200;

let session: JournalSnapshot | null = null;

export function startSession(input: {
  toolId: JournalToolId;
  taskId?: string | null;
  title?: string | null;
}): JournalSnapshot {
  session = {
    sessionId: crypto.randomUUID(),
    toolId: input.toolId,
    taskId: input.taskId ?? null,
    title: input.title ?? null,
    startedAt: Date.now(),
    events: [
      {
        t: 0,
        type: "session_start",
        detail: input.title
          ? `${input.toolId}: ${input.title}`
          : String(input.toolId),
      },
    ],
  };
  return session;
}

export function logEvent(type: string, detail?: string): void {
  if (!session) {
    startSession({ toolId: "home" });
  }
  if (!session) return;
  session.events.push({
    t: Date.now() - session.startedAt,
    type,
    detail: detail?.slice(0, 500),
  });
  if (session.events.length > MAX_EVENTS) {
    session.events = session.events.slice(-MAX_EVENTS);
  }
}

export function getJournalSnapshot(): JournalSnapshot | null {
  if (!session) return null;
  return {
    ...session,
    events: session.events.map((e) => ({ ...e })),
  };
}

export function formatJournalMarkdown(snap: JournalSnapshot): string {
  const lines = [
    `Session \`${snap.sessionId}\``,
    `- Tool: **${snap.toolId}**`,
    snap.taskId ? `- Task id: \`${snap.taskId}\`` : null,
    snap.title ? `- Title: ${snap.title}` : null,
    `- Started: ${new Date(snap.startedAt).toISOString()}`,
    "",
    "### Timeline",
  ].filter(Boolean) as string[];

  for (const ev of snap.events) {
    const sec = (ev.t / 1000).toFixed(1);
    lines.push(
      `- \`+${sec}s\` **${ev.type}**${ev.detail ? ` — ${ev.detail}` : ""}`,
    );
  }
  return lines.join("\n");
}
