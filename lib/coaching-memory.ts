import { supabase, anthropic, fetchPrompt, stripMarkdownJson } from "./ai";

// ─── Types ───

interface SessionSummary {
  session_number: number;
  date: string;
  summary: string;
  outcome: string | null;
}

interface HisPattern {
  pattern: string;
  coaching_response: string;
  confidence: number;
  last_seen: string;
}

interface WhatWorks {
  insight: string;
  evidence: string;
  confidence: number;
}

interface Decision {
  decision: string;
  reason: string;
  session_number: number;
  date: string;
  status: "active" | "revisited" | "superseded";
  revisited_at: string | null;
}

export interface CoachingMemory {
  arc?: string;
  his_patterns?: HisPattern[];
  what_works?: WhatWorks[];
  decisions?: Decision[];
  session_summaries?: SessionSummary[];
  session_count?: number;
  synthesis_count?: number;
  last_synthesis_at?: string;
  updated_at?: string;
}

// ─── 1. generateSessionSummary ───
// Called when a cockpit session is archived. Uses Haiku for speed.
// Returns { summary, decision } where decision may be null.

interface SummaryResult {
  summary: string;
  decision: { type: string; reason: string } | null;
}

export async function generateSessionSummary(
  sessionMessages: Array<{ role: string; content: string }>,
  contactContext: { name: string; intention: string; dates_count: number }
): Promise<SummaryResult | null> {
  if (!sessionMessages || sessionMessages.length < 3) return null;

  const recentMessages = sessionMessages.slice(-20);
  const messageText = recentMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: `Summarize this coaching session in 2-4 sentences. Focus on:
- What was discussed (what situation, what advice was given)
- What the user decided to do
- Any notable patterns in how he responds to coaching
- Where things stand with her

CRITICAL: If a major relationship decision was made in this session, flag it.
Major decisions include: ending the relationship, taking a break, setting a boundary,
changing intent (e.g. serious to casual), deciding to go exclusive.

Contact: ${contactContext.name} (intent: ${contactContext.intention}, dates: ${contactContext.dates_count})

Session:
${messageText}

Return a JSON object:
{"summary": "2-4 sentence summary", "decision": {"type": "end_contact | take_break | set_boundary | change_intent | go_exclusive | null", "reason": "Why (1 sentence)"}}

If no major decision was made, set decision.type to null.
Return ONLY the JSON, nothing else.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

    // Try parsing as JSON
    try {
      const parsed = JSON.parse(stripMarkdownJson(raw));
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : raw,
        decision: parsed.decision?.type && parsed.decision.type !== "null" ? parsed.decision : null,
      };
    } catch {
      // Fallback: treat entire response as plain summary, no decision
      return { summary: raw, decision: null };
    }
  } catch (err) {
    console.error("[CoachingMemory] Summary generation failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── 2. appendSessionSummary ───
// Adds a summary + optional decision to coaching memory

export function appendSessionSummary(
  memory: CoachingMemory,
  result: SummaryResult,
  sessionNumber: number
): CoachingMemory {
  const summaries = Array.isArray(memory.session_summaries) ? [...memory.session_summaries] : [];

  summaries.push({
    session_number: sessionNumber,
    date: new Date().toISOString(),
    summary: result.summary,
    outcome: null,
  });

  const updated = { ...memory, session_summaries: summaries };

  // Append decision if one was detected
  if (result.decision && result.decision.type) {
    const decisions = Array.isArray(updated.decisions) ? [...updated.decisions] : [];
    decisions.push({
      decision: result.decision.type,
      reason: result.decision.reason || "",
      session_number: sessionNumber,
      date: new Date().toISOString(),
      status: "active",
      revisited_at: null,
    });
    updated.decisions = decisions;
  }

  return updated;
}

// ─── 3. buildCoachingContext ───
// Pure function. Reads coaching_memory and outputs plain English sentences.
// Active decisions surface FIRST — they're the highest priority context.

const DECISION_CONTEXT: Record<string, (reason: string) => string> = {
  end_contact: (r) => `IMPORTANT: He previously decided to end things with her. Reason: ${r}. If he's re-engaging, challenge this — ask what changed about the situation, not just her texting.`,
  take_break: (r) => `He decided to take a break from this contact. Reason: ${r}. If he's back early, check if something actually changed.`,
  set_boundary: (r) => `He set a boundary with her: ${r}. Make sure he's holding it.`,
  change_intent: (r) => `He changed his intention with her: ${r}. Coach accordingly.`,
  go_exclusive: (r) => `He decided to pursue exclusivity with her. ${r}.`,
};

export function buildCoachingContext(memory: CoachingMemory | null): string {
  if (!memory || !memory.session_count || memory.session_count < 2) return "";

  const lines: string[] = [];

  // ACTIVE DECISIONS — surface first, always
  if (memory.decisions && memory.decisions.length > 0) {
    const active = memory.decisions.filter((d) => d.status === "active");
    for (const d of active) {
      const builder = DECISION_CONTEXT[d.decision];
      if (builder) lines.push(builder(d.reason));
    }
  }

  if (memory.arc) {
    lines.push(memory.arc);
  }

  if (memory.his_patterns && memory.his_patterns.length > 0) {
    const topPatterns = [...memory.his_patterns]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2);
    for (const p of topPatterns) {
      if (p.confidence >= 0.6) {
        lines.push(`${p.pattern}. ${p.coaching_response}`);
      }
    }
  }

  if (memory.what_works && memory.what_works.length > 0) {
    const topInsight = [...memory.what_works]
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (topInsight.confidence >= 0.6) {
      lines.push(topInsight.insight);
    }
  }

  if (memory.session_summaries && memory.session_summaries.length > 0) {
    const last = memory.session_summaries[memory.session_summaries.length - 1];
    lines.push(`Last session: ${last.summary}`);
  }

  return lines.slice(0, 6).join(" ");
}

// ─── 4. windowSessionSummaries ───
// Keep last 10 summaries

export function windowSessionSummaries(memory: CoachingMemory): CoachingMemory {
  if (!memory.session_summaries || memory.session_summaries.length <= 10) return memory;
  return {
    ...memory,
    session_summaries: memory.session_summaries.slice(-10),
  };
}

// ─── 5. triggerCoachingSynthesis ───
// Rebuilds arc, his_patterns, what_works from session summaries

export async function triggerCoachingSynthesis(
  contactId: string
): Promise<void> {
  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("coaching_memory, name, intention, dates_count")
      .eq("id", contactId)
      .single();

    if (!contact) return;

    const memory = (contact.coaching_memory as CoachingMemory) ?? {};
    const summaries = memory.session_summaries;
    if (!summaries || summaries.length < 3) return;

    const prompt = await fetchPrompt("coaching_synthesis");
    if (!prompt) {
      console.error("[CoachingMemory] coaching_synthesis prompt not found");
      return;
    }

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: prompt,
      messages: [
        {
          role: "user",
          content: `Contact: ${contact.name} (intent: ${contact.intention}, dates: ${contact.dates_count})

Session summaries (${summaries.length} total, chronological):
${summaries.map((s) => `Session ${s.session_number} (${s.date.slice(0, 10)}): ${s.summary}${s.outcome ? ` → ${s.outcome}` : ""}`).join("\n")}

${memory.arc ? `Current arc: ${memory.arc}` : "No existing arc."}
${memory.his_patterns?.length ? `Current patterns: ${JSON.stringify(memory.his_patterns)}` : "No existing patterns."}

Synthesize into arc, his_patterns, and what_works. Return JSON only.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text : "";

    let synthesis: { arc?: string; his_patterns?: HisPattern[]; what_works?: WhatWorks[] };
    try {
      synthesis = JSON.parse(stripMarkdownJson(text));
    } catch {
      console.error("[CoachingMemory] Synthesis parse failed:", text.slice(0, 200));
      return;
    }

    const updated: CoachingMemory = {
      ...memory,
      arc: synthesis.arc ?? memory.arc,
      his_patterns: synthesis.his_patterns ?? memory.his_patterns,
      what_works: synthesis.what_works ?? memory.what_works,
      synthesis_count: (memory.synthesis_count ?? 0) + 1,
      last_synthesis_at: new Date().toISOString(),
    };

    await supabase
      .from("contacts")
      .update({ coaching_memory: updated })
      .eq("id", contactId);

    console.log("[CoachingMemory] Synthesis complete for", contactId);
  } catch (err) {
    console.error("[CoachingMemory] Synthesis error:", err instanceof Error ? err.message : err);
  }
}

// ─── 6. archiveSessionWithSummary ───
// Complete archive flow: generate summary, append, window, save, maybe synthesize.
// Called from the cockpit archive route.

export async function archiveSessionWithSummary(
  contactId: string,
  userId: string,
  sessionMessages: Array<{ role: string; content: string }>
): Promise<void> {
  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("name, intention, dates_count, coaching_memory")
      .eq("id", contactId)
      .single();

    if (!contact) return;

    // Generate summary (includes decision detection)
    const result = await generateSessionSummary(sessionMessages, {
      name: contact.name,
      intention: contact.intention ?? "unknown",
      dates_count: contact.dates_count ?? 0,
    });

    let memory = (contact.coaching_memory as CoachingMemory) ?? {};
    const sessionCount = (memory.session_count ?? 0) + 1;

    if (result) {
      memory = appendSessionSummary(memory, result, sessionCount);
      memory = windowSessionSummaries(memory);
    }

    // Decision revisiting: if there were active decisions and the session had 6+ messages
    // (user continued past the challenge), mark active decisions as revisited
    if (memory.decisions && sessionMessages.length >= 6) {
      const active = memory.decisions.filter((d) => d.status === "active");
      if (active.length > 0) {
        for (const d of active) {
          d.status = "revisited";
          d.revisited_at = new Date().toISOString();
        }
      }
    }

    memory.session_count = sessionCount;
    memory.updated_at = new Date().toISOString();

    await supabase
      .from("contacts")
      .update({ coaching_memory: memory })
      .eq("id", contactId);

    // Deactivate the session
    await supabase
      .from("cockpit_sessions")
      .update({ is_active: false })
      .eq("contact_id", contactId)
      .eq("user_id", userId)
      .eq("is_active", true);

    // Trigger synthesis every 5 sessions
    if (sessionCount % 5 === 0) {
      triggerCoachingSynthesis(contactId).catch(console.error);
    }

    console.log("[CoachingMemory] Session archived for", contactId, "count:", sessionCount);
  } catch (err) {
    console.error("[CoachingMemory] Archive error:", err instanceof Error ? err.message : err);
  }
}
