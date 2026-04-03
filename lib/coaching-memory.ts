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

export interface CoachingMemory {
  arc?: string;
  his_patterns?: HisPattern[];
  what_works?: WhatWorks[];
  session_summaries?: SessionSummary[];
  session_count?: number;
  synthesis_count?: number;
  last_synthesis_at?: string;
  updated_at?: string;
}

// ─── 1. generateSessionSummary ───
// Called when a cockpit session is archived. Uses Haiku for speed.

export async function generateSessionSummary(
  sessionMessages: Array<{ role: string; content: string }>,
  contactContext: { name: string; intention: string; dates_count: number }
): Promise<string> {
  if (!sessionMessages || sessionMessages.length < 3) return "";

  const recentMessages = sessionMessages.slice(-20);
  const messageText = recentMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Summarize this coaching session in 2-4 sentences. Focus on:
- What was discussed (what situation, what advice was given)
- What the user decided to do
- Any notable patterns in how he responds to coaching
- Where things stand with her

Contact: ${contactContext.name} (intent: ${contactContext.intention}, dates: ${contactContext.dates_count})

Session:
${messageText}

Return ONLY the summary, nothing else.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text.trim() : "";
  } catch (err) {
    console.error("[CoachingMemory] Summary generation failed:", err instanceof Error ? err.message : err);
    return "";
  }
}

// ─── 2. appendSessionSummary ───
// Adds a summary to session_summaries array

export function appendSessionSummary(
  memory: CoachingMemory,
  summary: string,
  sessionNumber: number
): CoachingMemory {
  const summaries = Array.isArray(memory.session_summaries) ? [...memory.session_summaries] : [];

  summaries.push({
    session_number: sessionNumber,
    date: new Date().toISOString(),
    summary,
    outcome: null,
  });

  return { ...memory, session_summaries: summaries };
}

// ─── 3. buildCoachingContext ───
// Pure function. Reads coaching_memory and outputs 3-5 plain English sentences.

export function buildCoachingContext(memory: CoachingMemory | null): string {
  if (!memory || !memory.session_count || memory.session_count < 2) return "";

  const lines: string[] = [];

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

  return lines.slice(0, 5).join(" ");
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

    // Generate summary
    const summary = await generateSessionSummary(sessionMessages, {
      name: contact.name,
      intention: contact.intention ?? "unknown",
      dates_count: contact.dates_count ?? 0,
    });

    let memory = (contact.coaching_memory as CoachingMemory) ?? {};
    const sessionCount = (memory.session_count ?? 0) + 1;

    if (summary) {
      memory = appendSessionSummary(memory, summary, sessionCount);
      memory = windowSessionSummaries(memory);
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
