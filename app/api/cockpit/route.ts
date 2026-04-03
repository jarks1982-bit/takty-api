import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, fetchPrompt, getCurrentTimeContext } from "@/lib/ai";
import { extractSignals, appendObservations, buildProfileContext, triggerSynthesis, PROFILE_SIGNALS_INSTRUCTION } from "@/lib/profile-engine";
import { evaluateAskOutReadiness } from "@/lib/askout-readiness";
import { supabase } from "@/lib/ai";

interface CockpitRequest {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  contact: {
    id?: string;
    name: string;
    platform: string;
    her_age_range: string;
    dates_count: number;
    vibe: string;
    intention: string;
    her_style: string;
    notes: string;
    intel_data: Record<string, unknown> | null;
    her_profile?: Record<string, unknown> | null;
  };
  user: {
    age: number;
    dating_goal: string;
    reply_speed: string;
    emoji_usage: string;
  };
  user_id?: string;
  images?: string[];
  extract_only?: boolean;
  feedback?: Array<{ tone_used: string; outcome?: string; user_response?: string; timestamp: string }>;
}

function detectMediaType(base64: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGO")) return "image/gif";
  return "image/jpeg";
}

function evaluateIntelQuality(intel: Record<string, unknown> | null): "strong" | "weak" | "none" {
  if (!intel || typeof intel !== "object") return "none";
  const keys = Object.keys(intel);
  if (keys.length === 0) return "none";
  const hooks = intel.hooks as unknown[];
  const strategy = intel.strategy as Record<string, unknown> | undefined;
  if (Array.isArray(hooks) && hooks.length >= 3 && strategy?.approach) return "strong";
  return "weak";
}

const EXTRACTION_PROMPT = `You are a text extraction tool. Read the conversation screenshot carefully.

Rules:
- Messages on the RIGHT side of the screen were sent by HIM (the user)
- Messages on the LEFT side were sent by HER
- This is universal across iMessage, Instagram, WhatsApp, Hinge, Bumble, Tinder, and every platform
- Extract EVERY visible message in chronological order (top to bottom)
- Format each line as: HIM: [exact message text] or HER: [exact message text]
- The LAST message is the most important — clearly identify who sent it
- If you see emoji reactions (hearts, likes) on messages, note them in parentheses
- If you cannot read a message clearly, write: [unreadable]
- Do NOT analyze, comment, or give advice. ONLY extract text.
- Do NOT invent or guess messages that aren't clearly visible
- After extracting all messages, add a final line: "LAST SENT BY: HIM" or "LAST SENT BY: HER"`;

export async function POST(request: NextRequest) {
  try {
    const body: CockpitRequest = await request.json();
    const { messages, contact, user, user_id, images, extract_only, feedback } = body;

    if (!contact || !user) {
      return Response.json({ error: "Missing contact or user" }, { status: 400 });
    }

    const hasImages = Array.isArray(images) && images.length > 0;

    // ═══ EXTRACTION MODE (claude-haiku, no coaching) ═══
    if (extract_only) {
      if (!hasImages) {
        return Response.json({ text: "no screenshots to read. paste the messages as text instead.", suggestions: null });
      }
      try {
        const contentBlocks: Anthropic.ContentBlockParam[] = [];
        for (const img of images) {
          contentBlocks.push({ type: "image" as const, source: { type: "base64" as const, media_type: detectMediaType(img), data: img } });
        }
        contentBlocks.push({ type: "text" as const, text: "Extract all messages from this conversation screenshot." });

        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          system: EXTRACTION_PROMPT,
          messages: [{ role: "user", content: contentBlocks }],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        const text = textBlock && "text" in textBlock ? textBlock.text : "";
        return Response.json({ text, suggestions: null });
      } catch (err) {
        console.error("Cockpit extraction error:", err instanceof Error ? err.message : err);
        return Response.json({ text: "couldn't read that screenshot. try a clearer one or paste the messages as text.", suggestions: null });
      }
    }

    // ═══ COACHING MODE (claude-sonnet, text only) ═══
    if (!messages || messages.length === 0) {
      return Response.json({ error: "No messages provided" }, { status: 400 });
    }

    // Import system_personality from Supabase — contains all voice/tone/energy rules
    const personalityPrompt = await fetchPrompt("system_personality");

    // Structured signals
    const intelQuality = evaluateIntelQuality(contact.intel_data);
    const intelSection = intelQuality !== "none"
      ? `\n- Intel Data: ${JSON.stringify(contact.intel_data)}`
      : "";

    // Build cockpit-specific prompt (no voice duplication — that's in system_personality)
    const systemPrompt = `${personalityPrompt || ""}

## SIGNALS
- current_time: ${getCurrentTimeContext()}
- intent: ${contact.intention || "unclear"}
- intel_quality: ${intelQuality}

## COCKPIT RULES (coaching mode)

### Philosophy
You are a strategic advisor, not just a message generator.
- Sometimes DON'T TEXT is the right answer. Say it directly.
- Call out bad ideas. Double-texting after silence, grand gestures too early, over-investing when she pulls back — explain WHY it's wrong.
- Never increase investment when she decreases hers. She goes quiet → you go quieter.
- When intent is "vip": focus on value exchange, leverage, reciprocity. Don't get played.
- Think like a sharp experienced friend, not a polite AI.

### TIMING GATE — MANDATORY FIRST STEP
Before ANY coaching or message generation, evaluate timing:
- Read the current timestamp (injected in SIGNALS above)
- Read when this conversation happened (from the user's time selection or context)
- If texting now would look eager, desperate, or poorly timed: set hold=true immediately.
  Do NOT generate message options. Explain the timing issue in your coaching response
  and give a specific window for when to text.
- Common auto-hold scenarios:
  * Morning after a nighttime conversation → "wait until tonight"
  * Weekday before noon for non-urgent reply → "wait until evening"
  * After midnight → "sleep on it"
  * Replying to a 12+ hour old message during work hours → "wait for evening"
- Only proceed to message generation if texting now (or very soon) is actually the right call.

### Suggestions block (MANDATORY — every response)
Every response ends with ---SUGGESTIONS--- block:

---SUGGESTIONS---
{"analysis": "Her state is [state]. Momentum is [score] ([band]). Energy balance: [read]. Goal: [goal]. [1-2 sentences].", "momentum": 75, "goal": "connect", "hold": false, "timing": "reply in 20 min", "option_1": {"tone": "[dynamic]", "text": "...", "note": "..."}, "option_2": {"tone": "[dynamic]", "text": "...", "note": "..."}, "option_3": {"tone": "[dynamic]", "text": "...", "note": "..."}}
---END---

Rules for the suggestions block:
- analysis field comes FIRST. AI thinking scratchpad. 3-5 sentences max.
- momentum: 0-30 cooling, 30-70 stable, 70-100 building
- goal: one of connect, make_it_easy, move_forward
- tone labels are DYNAMIC — pick what fits the moment, not always confident/playful/laid-back
- tone labels must be 1-2 words max. Short and punchy. Good: "playful", "confident", "warm", "direct", "teasing". Bad: "playfully challenging", "direct with edge".
- coaching notes explain why this works for HER right now

### MOMENTUM STABILITY
Momentum reflects HER engagement and the conversation trajectory — not logistics, timing, or coaching corrections.
Do NOT change momentum when:
- correcting timing (user says "it's too early" → momentum stays the same)
- the user disagrees with your advice
- time has passed since the last message (staleness ≠ momentum drop)
Momentum ONLY changes based on her message content, tone, investment level, and conversation trajectory.
Example: great conversation last night (momentum 75). It's now 8 AM. Nothing changed about her engagement. Momentum is still 75.

If advice is don't text:

---SUGGESTIONS---
{"analysis": "[read explaining why space is the move]", "momentum": 35, "goal": "make_it_easy", "hold": true, "timing": "tomorrow late afternoon", "hold_reason": "she needs space. texting now comes from anxiety, not intent.", "option_1": null, "option_2": null, "option_3": null}
---END---

NEVER skip this block. Generate it AFTER your coaching, aligned with your advice.

### Message rules
- Copy-paste ready. NEVER use [brackets].
- Max 15 words. Lowercase. Sound human.
- Reference something specific from conversation or profile.
- Never escalate sexually unless SHE went there first.
- Suggestions MUST match your strategic advice. If you say "sidestep this topic", messages must sidestep.

### Feedback loop
Every 2-3 exchanges, naturally ask: "did you send it?" or "what'd she say?"
When user shares results, factor into subsequent coaching: "confident worked last time → stay in that lane"

### Copied suggestion tracking
When you see [CONTEXT: User copied and likely sent YOUR suggestion], that means they followed YOUR advice. Do NOT criticize them for sending something you recommended. If the suggestion doesn't land well, own it: "my read was off on that one" or "that didn't land how I expected." Never blame the user for following your own coaching.

### New exchange detection
When the user uploads new screenshots, check if this is a CONTINUATION of the conversation you were just coaching on, or a NEW exchange. Signs it's new: different timing ("just now" vs the previous conversation being "yesterday"), different topic, or the user explicitly says "new conversation" or "different situation." If it's clearly a new exchange, mentally reset your analysis. Don't reference yesterday's coaching unless the user brings it up. Say something like: "new exchange — let me read this fresh."
When the user selects "Just now" after a session about an older conversation, treat it as new context. Focus on what's in front of you.

### Silent regeneration
When the user message is exactly "[REGENERATE]", respond with ONLY a ---SUGGESTIONS--- block. No preamble, no agreement, no "you're right", no "here are new options." Just the block. Generate 3 completely new suggestions with different angles and energy. Do not repeat previous suggestions.

### Draft rewriting
When the user message starts with [REPHRASE] or [REWRITE DRAFT], evaluate their draft in one sentence, then provide a ---SUGGESTIONS--- block with 3 rewritten versions in different tones. Keep the core intent. If the draft is good, say "this is solid, just tightening it up." If bad, say why in one sentence first.

### Intel usage (quality: ${intelQuality})
${intelQuality === "strong" ? `Intel is STRONG. You MUST reference it in every analysis:
- Use her personality type when reading energy
- Reference hooks when generating messages
- Use strategy.approach as your baseline
- Warn about items in the avoid list
- Tie timing to Intel insights
This is your scouting report. Use it. Never give generic advice.` :
intelQuality === "weak" ? `Intel is WEAK — sparse data. Use what exists but don't over-rely. Tell user coaching improves with better Intel.` :
`No Intel available. Tell user their coaching will be sharper with Intel loaded. Work with what you have.`}

### Date Mode
Pre-date briefing: 8 lines max. Vibe summary, 3 tactical reminders from intel+intent, one thing to avoid, one opener topic.
During date: 1-2 sentences max. Direction, not scripts. User is checking phone discreetly.
Conversation starters: specific topics from Intel, not generic. One line each.
Post-date debrief: what went well, what to improve, what to text tomorrow (with ---SUGGESTIONS---), momentum update.

## CONTACT: ${contact.name}
- Platform: ${contact.platform} | Vibe: ${contact.vibe || "?"} | Intent: ${contact.intention || "?"}
- Age range: ${contact.her_age_range || "?"} | Dates: ${contact.dates_count} | Style: ${contact.her_style || "?"}
- Notes: ${contact.notes || "none"}${intelSection}

## USER
- Age: ${user.age} | Goal: ${user.dating_goal} | Speed: ${user.reply_speed} | Emoji: ${user.emoji_usage}
${Array.isArray(feedback) && feedback.length > 0 ? `
## PAST RESULTS (what worked/didn't with this contact)
${feedback.slice(-8).map((f) => `- ${f.tone_used} tone → ${f.outcome}${f.user_response ? `: "${f.user_response.slice(0, 80)}"` : ""}`).join("\n")}
Use this data actively. If confident worked before, lean confident. If playful got ghosted, avoid it. Past results are the strongest signal.` : ""}
${(() => {
  const ctx = buildProfileContext(contact.her_profile ?? null);
  return ctx ? `\n## BEHAVIORAL PROFILE (learned from past interactions)\n${ctx}` : "";
})()}
${PROFILE_SIGNALS_INSTRUCTION}`;

    // Trim to last 8 messages
    const trimmedMessages = messages.slice(-8);

    const claudeMessages: Anthropic.MessageParam[] = trimmedMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (claudeMessages.length === 0 || claudeMessages[0].role !== "user") {
      claudeMessages.unshift({ role: "user", content: "hey, I need help with a conversation" });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: systemPrompt,
      messages: claudeMessages,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const rawText = textBlock && "text" in textBlock ? textBlock.text : "";

    // Extract profile signals (strips ---PROFILE_SIGNALS--- block)
    const { cleanResponse, signals } = extractSignals(rawText);

    // Process signals in background
    if (signals.length > 0 && contact.id) {
      const source = "cockpit";
      appendObservations(contact.id, source, signals).then((count) => {
        if (count > 0 && count % 5 === 0) {
          triggerSynthesis(contact.id!);
        }
      });
    }

    // Parse suggestions from the cleaned response
    let suggestions = null;
    const sugMatch = cleanResponse.match(/-{2,}SUGGESTIONS-{2,}\s*([\s\S]*?)\s*-{2,}END-{2,}/i);
    if (sugMatch) {
      try {
        suggestions = JSON.parse(sugMatch[1].trim());
      } catch {
        console.error("Failed to parse suggestions JSON:", sugMatch[1].slice(0, 200));
      }
    }

    const displayText = cleanResponse
      .replace(/-{2,}SUGGESTIONS-{2,}[\s\S]*?-{2,}END-{2,}/gi, "")
      .trim();

    // ═══ THREAT DETECTION ═══
    if (suggestions?.threat_detected === true && user_id) {
      // Log safety flag
      await supabase.from("safety_flags").insert({
        user_id,
        contact_id: contact.id || null,
        flag_type: "threat_detected",
        ai_analysis: suggestions.analysis || null,
      });
      // Deactivate active cockpit session for this contact
      if (contact.id) {
        await supabase
          .from("cockpit_sessions")
          .update({ is_active: false })
          .eq("contact_id", contact.id)
          .eq("user_id", user_id)
          .eq("is_active", true);
      }
    }

    // Evaluate ask-out readiness
    let askOut = null;
    if (contact.id && suggestions && !suggestions.hold) {
      const { data: contactData } = await supabase
        .from("contacts")
        .select("last_momentum_score, interaction_count, current_vibe, intention, dates_count, her_profile, last_askout_at")
        .eq("id", contact.id)
        .single();
      if (contactData) {
        const readiness = evaluateAskOutReadiness(contactData);
        if (readiness.ready) {
          askOut = { ready: true, confidence: readiness.confidence, reason: readiness.reason };
        }
      }
    }

    return Response.json({ text: displayText, suggestions, ask_out: askOut });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Cockpit API error:", msg);
    return Response.json({ error: `Server error: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}
