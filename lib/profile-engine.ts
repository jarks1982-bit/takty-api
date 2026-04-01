import { supabase, anthropic, fetchPrompt, stripMarkdownJson } from "./ai";

// ─── Types ───

interface Signal {
  type: "engagement" | "tone" | "timing" | "interest" | "pattern" | "outcome" | "strategy_outcome";
  direction: "increase" | "decrease" | "stable" | "new" | "confirmed" | "negative";
  evidence: string;
}

interface Observation extends Signal {
  source: string;
  trust: "high" | "medium" | "low";
  timestamp: string;
}

interface HerProfile {
  observations?: Observation[];
  personality?: Record<string, unknown>;
  interests?: Record<string, unknown>;
  communication?: Record<string, unknown> | null;
  what_works?: Record<string, unknown> | null;
  attachment_style?: unknown;
  emotional_depth?: unknown;
  conflict_style?: unknown;
  love_language_signals?: unknown;
  relationship_patterns?: unknown;
  observation_count?: number;
  synthesis_count?: number;
  last_synthesis?: string;
  synthesis?: Record<string, unknown>;
}

const SOURCE_TRUST: Record<string, "high" | "medium" | "low"> = {
  screenshot: "high",
  outcome: "high",
  debrief: "medium",
  feedback: "medium",
  cockpit: "medium",
  user_interpretation: "low",
};

// ─── 1. extractSignals ───
// Parses ---PROFILE_SIGNALS--- block from AI response, strips it from visible text

export function extractSignals(aiResponse: string): { cleanResponse: string; signals: Signal[] } {
  const match = aiResponse.match(/-{2,}PROFILE_SIGNALS-{2,}\s*([\s\S]*?)\s*-{2,}END_SIGNALS-{2,}/i);

  if (!match) {
    return { cleanResponse: aiResponse, signals: [] };
  }

  let signals: Signal[] = [];
  try {
    const parsed = JSON.parse(match[1].trim());
    if (Array.isArray(parsed.signals)) {
      signals = parsed.signals.filter(
        (s: Record<string, unknown>) => s.type && s.direction && s.evidence
      );
    }
  } catch {
    console.error("[ProfileEngine] Failed to parse signals JSON:", match[1].slice(0, 200));
  }

  // Strip the signals block from the response
  const cleanResponse = aiResponse
    .replace(/-{2,}PROFILE_SIGNALS-{2,}[\s\S]*?-{2,}END_SIGNALS-{2,}/gi, "")
    .trim();

  return { cleanResponse, signals };
}

// ─── 2. appendObservations ───
// Adds structured observations to her_profile.observations in Supabase

export async function appendObservations(
  contactId: string,
  source: string,
  signals: Signal[]
): Promise<number> {
  if (signals.length === 0) return 0;

  const trust = SOURCE_TRUST[source] ?? "medium";
  const timestamp = new Date().toISOString();

  const newObservations: Observation[] = signals.map((s) => ({
    ...s,
    source,
    trust,
    timestamp,
  }));

  // Fetch current profile
  const { data } = await supabase
    .from("contacts")
    .select("her_profile, interaction_count")
    .eq("id", contactId)
    .single();

  const profile = (data?.her_profile as HerProfile) ?? {};
  const existingObs = Array.isArray(profile.observations) ? profile.observations : [];
  const updatedObs = [...existingObs, ...newObservations];
  const newCount = (data?.interaction_count ?? 0) + 1;

  await supabase
    .from("contacts")
    .update({
      her_profile: {
        ...profile,
        observations: updatedObs,
        observation_count: updatedObs.length,
      },
      interaction_count: newCount,
    })
    .eq("id", contactId);

  return newCount;
}

// ─── 3. buildProfileContext ───
// Converts her_profile into 3-5 plain English sentences for prompt injection

export function buildProfileContext(herProfile: Record<string, unknown> | null): string {
  if (!herProfile || typeof herProfile !== "object") return "";

  const profile = herProfile as HerProfile;

  // If no synthesis has run, return empty
  if (!profile.synthesis || !profile.synthesis_count) return "";

  const syn = profile.synthesis as Record<string, unknown>;
  const lines: string[] = [];

  // Communication
  const comm = syn.communication as Record<string, unknown> | null;
  if (comm && typeof comm.confidence === "number" && comm.confidence >= 0.6) {
    const hedge = comm.confidence < 0.7 ? "tends to" : "";
    const parts: string[] = [];
    if (comm.response_speed) parts.push(`${hedge} replies ${comm.response_speed}`);
    if (comm.most_active) parts.push(`most active ${comm.most_active}`);
    if (comm.goes_quiet) parts.push(`goes quiet ${comm.goes_quiet}`);
    if (parts.length > 0) lines.push(parts.join(", "));
  }

  // What works
  const ww = syn.what_works as Record<string, unknown> | null;
  if (ww && typeof ww.confidence === "number" && ww.confidence >= 0.6) {
    const hedge = ww.confidence < 0.7 ? "seems to respond best to" : "responds best to";
    if (ww.best_tone) lines.push(`${hedge} ${ww.best_tone} tone`);
    const lands = ww.topics_that_land as string[] | undefined;
    if (lands && lands.length > 0) lines.push(`topics that land: ${lands.slice(0, 3).join(", ")}`);
    const fails = ww.failed_strategies as string[] | undefined;
    if (fails && fails.length > 0) lines.push(`avoid: ${fails.slice(0, 2).join(", ")}`);
  }

  // Personality
  const pers = syn.personality as Record<string, unknown> | null;
  if (pers && typeof pers.confidence === "number" && pers.confidence >= 0.6) {
    const behaviors = pers.observed_behaviors as string[] | undefined;
    if (behaviors && behaviors.length > 0) {
      lines.push(behaviors.slice(0, 2).join(". "));
    }
  }

  // Interests
  const interests = syn.interests as Record<string, unknown> | null;
  if (interests) {
    const confirmed = interests.confirmed as Array<{ topic: string }> | undefined;
    if (confirmed && confirmed.length > 0) {
      lines.push(`engages with: ${confirmed.slice(0, 3).map((i) => i.topic).join(", ")}`);
    }
  }

  return lines.slice(0, 5).join(". ").replace(/\.\./g, ".") + (lines.length > 0 ? "." : "");
}

// ─── 4. windowObservations ───
// If observations exceed 50, return windowed set

export function windowObservations(observations: Observation[]): Observation[] {
  if (observations.length <= 50) return observations;

  // Last 30 most recent
  const recent = observations.slice(-30);

  // From the rest, pick top 20 high-trust (prioritize strategy_outcome)
  const older = observations.slice(0, -30);
  const scored = older.map((o) => ({
    obs: o,
    score:
      (o.trust === "high" ? 3 : o.trust === "medium" ? 2 : 1) +
      (o.type === "strategy_outcome" ? 2 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topOlder = scored.slice(0, 20).map((s) => s.obs);

  return [...topOlder, ...recent];
}

// ─── 5. triggerSynthesis ───
// Fetches profile, windows observations, calls Claude, merges back

export async function triggerSynthesis(contactId: string): Promise<void> {
  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("her_profile, intel_data, name")
      .eq("id", contactId)
      .single();

    if (!contact) return;

    const profile = (contact.her_profile as HerProfile) ?? {};
    const observations = Array.isArray(profile.observations) ? profile.observations : [];

    if (observations.length < 3) return; // Not enough data

    const windowed = windowObservations(observations as Observation[]);
    const prompt = await fetchPrompt("profile_synthesis");
    if (!prompt) return;

    const intel = contact.intel_data as Record<string, unknown> | null;
    const intelSummary = intel
      ? `Intel personality: ${JSON.stringify(intel.the_read ?? intel.personality ?? "unknown").slice(0, 300)}`
      : "No Intel available.";

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: prompt,
      messages: [
        {
          role: "user",
          content: `Synthesize a behavioral profile for ${contact.name || "this contact"}.

${intelSummary}

Observations (${windowed.length} total):
${windowed.map((o) => `- [${o.type}/${o.direction}] ${o.evidence} (${o.trust} trust, ${o.source})`).join("\n")}

Return JSON with: personality (string), communication (string), what_works (string), top_interests (string[]), key_pattern (string), personality_confidence (0-1).`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text : "";

    let synthesis: Record<string, unknown>;
    try {
      synthesis = JSON.parse(stripMarkdownJson(text));
    } catch {
      console.error("[ProfileEngine] Synthesis parse failed:", text.slice(0, 200));
      return;
    }

    // Merge back — preserve observations array and V2 reserved fields
    await supabase
      .from("contacts")
      .update({
        her_profile: {
          ...profile,
          synthesis,
          last_synthesis: new Date().toISOString(),
          synthesis_count: (profile.synthesis_count ?? 0) + 1,
          // Preserve V2 reserved fields
          attachment_style: profile.attachment_style ?? null,
          emotional_depth: profile.emotional_depth ?? null,
          conflict_style: profile.conflict_style ?? null,
          love_language_signals: profile.love_language_signals ?? null,
          relationship_patterns: profile.relationship_patterns ?? null,
        },
      })
      .eq("id", contactId);

    console.log("[ProfileEngine] Synthesis complete for", contactId);
  } catch (err) {
    console.error("[ProfileEngine] Synthesis error:", err instanceof Error ? err.message : err);
  }
}

// ─── Extraction instruction (append to coaching prompts) ───

export const PROFILE_SIGNALS_INSTRUCTION = `

---PROFILE_SIGNALS---
After your coaching response, output a profile signals block.
Extract 1-3 observations about HER from this interaction.
Each observation MUST use this exact format:
{"signals": [
{
"type": "engagement|tone|timing|interest|pattern|outcome|strategy_outcome",
"direction": "increase|decrease|stable|new|confirmed|negative",
"evidence": "specific observable behavior, max 15 words"
}
]}
RULES:
- Only note what is EVIDENT from her messages or the situation.
- Evidence must be specific and observable, not interpretive.
- Do NOT repeat a previously observed pattern unless this interaction provides NEW evidence.
- If nothing new is observable, return {"signals": []}
- When the user reports a failed approach, log as type: strategy_outcome, direction: negative.
- When the user reports success, log as type: strategy_outcome, direction: confirmed.
---END_SIGNALS---`;
