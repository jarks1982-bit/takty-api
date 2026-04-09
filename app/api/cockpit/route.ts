import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, fetchPrompt, getCurrentTimeContext, stripMarkdownJson } from "@/lib/ai";
import { extractSignals, appendObservations, buildProfileContext, triggerSynthesis, PROFILE_SIGNALS_INSTRUCTION } from "@/lib/profile-engine";
import { evaluateAskOutReadiness } from "@/lib/askout-readiness";
import { buildCoachingContext } from "@/lib/coaching-memory";
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
  stream?: boolean;
  last_suggestions?: Array<{ tone: string; text: string }>;
  images?: string[];
  extract_only?: boolean;
  feedback?: Array<{ tone_used: string; outcome?: string; user_response?: string; timestamp: string }>;
  time_ago?: string;
}

function interpretTiming(timeAgo: string): { response_delay_minutes: number; conversation_staleness: "fresh" | "warm" | "cold" } {
  const t = (timeAgo || "").toLowerCase();
  if (t.includes("just") || t.includes("now") || t.includes("minute"))
    return { response_delay_minutes: 5, conversation_staleness: "fresh" };
  if (t.includes("hour"))
    return { response_delay_minutes: 120, conversation_staleness: "fresh" };
  if (t.includes("today"))
    return { response_delay_minutes: 240, conversation_staleness: "warm" };
  if (t.includes("yesterday"))
    return { response_delay_minutes: 1440, conversation_staleness: "warm" };
  return { response_delay_minutes: 2880, conversation_staleness: "cold" };
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

CRITICAL — accuracy rules:
- Only transcribe messages that are clearly visible in the screenshot.
- If a message is partially cut off or unclear, transcribe only what is visible. Do not complete or infer the rest.
- Do not add, invent, or infer any messages beyond what is explicitly shown in the image.
- If you cannot confidently read a message, skip it entirely.
- Never complete a sentence or conversation that appears cut off.

Formatting rules:
- Messages on the RIGHT side of the screen were sent by HIM (the user)
- Messages on the LEFT side were sent by HER
- This is universal across iMessage, Instagram, WhatsApp, Hinge, Bumble, Tinder, and every platform
- Extract EVERY visible message in chronological order (top to bottom)
- Format each line as: HIM: [exact message text] or HER: [exact message text]
- The LAST message is the most important — clearly identify who sent it
- If you see emoji reactions (hearts, likes) on messages, note them in parentheses
- Do NOT analyze, comment, or give advice. ONLY extract text.
- After extracting all messages, add a final line: "LAST SENT BY: HIM" or "LAST SENT BY: HER"`;

export async function POST(request: NextRequest) {
  try {
    const body: CockpitRequest = await request.json();
    const { messages, contact, user, user_id, stream: streamMode, last_suggestions, images, extract_only, feedback, time_ago } = body;
    const timing = interpretTiming(time_ago || "");

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

    // Load coaching memory + last_known_state server-side
    let coachingContext = "";
    let lastKnownState: Record<string, unknown> | null = null;
    if (contact.id) {
      const { data: contactRow } = await supabase
        .from("contacts")
        .select("coaching_memory, last_known_state")
        .eq("id", contact.id)
        .single();
      if (contactRow?.coaching_memory) {
        coachingContext = buildCoachingContext(contactRow.coaching_memory as Record<string, unknown>);
      }
      if (contactRow?.last_known_state) {
        lastKnownState = contactRow.last_known_state as Record<string, unknown>;
      }
    }

    // Load last 5 messages from most recent archived session — only on a brand-new session
    const isNewSession = !messages || messages.length <= 1;
    let priorSessionContext = "";
    if (isNewSession && contact.id && user_id) {
      const { data: prevSession } = await supabase
        .from("cockpit_sessions")
        .select("text_messages, messages, updated_at")
        .eq("contact_id", contact.id)
        .eq("user_id", user_id)
        .eq("is_active", false)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prevSession) {
        const prev = ((prevSession.text_messages ?? prevSession.messages ?? []) as Array<{ role: string; content: string }>).slice(-5);
        if (prev.length > 0) {
          priorSessionContext = prev
            .map((m) => `${m.role === "user" ? "HIM" : "YOU"}: ${(m.content ?? "").slice(0, 300)}`)
            .join("\n");
        }
      }
    }

    // ═══ SESSION MEMORY COMPRESSION ═══
    // Keep last 6 messages as multi-turn; compress everything older into a structured block.
    let sessionMemoryBlock = "";
    if (messages.length > 6) {
      const older = messages.slice(0, -6);
      const transcript = older
        .map((m) => `${m.role === "user" ? "HIM" : "SUAVO"}: ${m.content}`)
        .join("\n");
      try {
        const memResp = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          system: `You compress earlier coaching-conversation messages into a structured memory block.
Output EXACTLY this format with no preamble, no extra text:

## SESSION MEMORY (earlier in this conversation)
- Her traits observed: [extracted from earlier messages, or "none yet"]
- Dynamic: [who's leading, who's qualifying, energy balance]
- Open loops: [topics raised but not resolved, or "none"]
- User frame: [how he's been showing up — confident, over-asking, etc.]
- Key decisions made: [anything Suavo recommended that user acted on, or "none"]

Be terse. One line per field. No narrative.`,
          messages: [{ role: "user", content: `Earlier transcript:\n${transcript}` }],
        });
        const memBlock = memResp.content.find((b) => b.type === "text");
        if (memBlock && "text" in memBlock) {
          sessionMemoryBlock = memBlock.text.trim();
        }
      } catch (err) {
        console.error("[Cockpit] session memory compression error:", err instanceof Error ? err.message : err);
      }
    }

    // Build cockpit-specific prompt (no voice duplication — that's in system_personality)
    const systemPrompt = `${personalityPrompt || ""}

## SIGNALS
- current_time: ${getCurrentTimeContext()}
- intent: ${contact.intention || "unclear"}
- intel_quality: ${intelQuality}
- response_delay_minutes: ${timing.response_delay_minutes}
- conversation_staleness: ${timing.conversation_staleness}${lastKnownState ? `
- last_known_state: ${JSON.stringify(lastKnownState)}` : ""}

## COCKPIT RULES (coaching mode)

### RESPONSE FORMAT (OVERRIDES system prompt OUTPUT FORMAT)
In this cockpit conversation, do NOT follow the OUTPUT FORMAT section from your system prompt.
Instead, respond with natural coaching text FIRST, then end with a ---SUGGESTIONS--- block.
The JSON structure from OUTPUT FORMAT applies INSIDE the suggestions block only.

Format every response like this:
1. Write coaching response as natural conversational text (this is what the user sees in chat)
2. End with exactly:
---SUGGESTIONS---
{json object}
---END---

CRITICAL: Do NOT output only JSON. Do NOT skip the coaching text. The user MUST see a natural response in the chat. The ---SUGGESTIONS--- delimiter is mandatory — never output raw JSON without it.

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
${Array.isArray(last_suggestions) && last_suggestions.length > 0 ? `
## LAST SUGGESTIONS YOU GAVE
You previously suggested these messages for him to send:
${last_suggestions.map((s, i) => `- Option ${i + 1} (${s.tone}): "${s.text}"`).join("\n")}

If you see any of these in a screenshot he uploads, YOU suggested them. Do not critique him for sending a message you recommended. If it didn't land well, own it.` : ""}
${(() => {
  const ctx = buildProfileContext(contact.her_profile ?? null);
  return ctx ? `\n## BEHAVIORAL PROFILE (learned from past interactions)\n${ctx}` : "";
})()}
${priorSessionContext ? `
## PRIOR SESSION (last messages from your most recent coaching session with him about her)
${priorSessionContext}

Use this only for continuity — pick up naturally if relevant. Do NOT recap it back. If this session is clearly a new situation, ignore it.` : ""}
${coachingContext ? `
## COACHING HISTORY
${coachingContext}

Use this context to:
- Reference previous sessions naturally ("last time we talked about this...")
- Avoid repeating advice that didn't work
- Match coaching style to what he responds to
- Build on what was decided in previous sessions
- CHALLENGE reversals of major decisions — if he decided to end it and now he's back, ask what changed before coaching forward

Do NOT:
- Repeat the coaching history back verbatim or reference session numbers
- Say "according to my records" or anything that breaks the friend voice
- Bring up a reversed decision more than once — one challenge is enough` : ""}
${sessionMemoryBlock ? `\n${sessionMemoryBlock}\n` : ""}
${PROFILE_SIGNALS_INSTRUCTION}`;

    // Multi-turn: keep last 6 messages as proper turns; older are compressed in sessionMemoryBlock
    const trimmedMessages = messages.slice(-6);

    const claudeMessages: Anthropic.MessageParam[] = trimmedMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (claudeMessages.length === 0 || claudeMessages[0].role !== "user") {
      claudeMessages.unshift({ role: "user", content: "hey, I need help with a conversation" });
    }

    // ═══ STREAMING MODE ═══
    if (streamMode) {
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            let fullText = "";

            const stream = anthropic.messages.stream({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1500,
              system: systemPrompt,
              messages: claudeMessages,
            });

            for await (const event of stream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                const chunk = event.delta.text;
                fullText += chunk;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text", content: chunk })}\n\n`));
              }
            }

            // Stream complete — run all post-processing on the full text
            const { cleanResponse, signals } = extractSignals(fullText);

            if (signals.length > 0 && contact.id) {
              appendObservations(contact.id, "cockpit", signals).catch((err) =>
                console.error("[Cockpit/stream] appendObservations error:", err)
              );
            }

            if (contact.id) {
              supabase.rpc("increment_interaction_count", { contact_id: contact.id }).then(({ data: newCount, error }) => {
                if (error) {
                  console.error("[Cockpit/stream] interaction_count increment error:", error.message);
                } else {
                  console.log("[Cockpit/stream] interaction_count now:", newCount);
                  if (newCount && newCount % 5 === 0) {
                    console.log("[Cockpit/stream] Triggering synthesis at interaction:", newCount);
                    triggerSynthesis(contact.id!);
                  }
                }
              });
            }

            // Parse suggestions (same 4-fallback logic)
            let suggestions: Record<string, unknown> | null = null;
            const s1 = cleanResponse.match(/-{2,}SUGGESTIONS-{2,}\s*([\s\S]*?)\s*-{2,}END-{2,}/i);
            if (s1) { try { suggestions = JSON.parse(stripMarkdownJson(s1[1])); } catch {} }
            if (!suggestions) { const s2 = cleanResponse.match(/-{2,}SUGGESTIONS-{2,}\s*([\s\S]*)/i); if (s2) { try { suggestions = JSON.parse(stripMarkdownJson(s2[1])); } catch {} } }
            if (!suggestions) { const t = cleanResponse.trim(); if (t.startsWith("{") && t.endsWith("}")) { try { const p = JSON.parse(stripMarkdownJson(t)); if (p.momentum !== undefined || p.hold !== undefined || p.option_1) suggestions = p; } catch {} } }
            if (!suggestions) { const tj = cleanResponse.match(/\n\s*(\{[\s\S]*"(?:momentum|option_1|hold|analysis)"[\s\S]*\})\s*$/); if (tj) { try { suggestions = JSON.parse(stripMarkdownJson(tj[1])); } catch {} } }

            // Build display text
            let displayText = cleanResponse;
            displayText = displayText.replace(/-{2,}SUGGESTIONS-{2,}[\s\S]*?(?:-{2,}END-{2,}|$)/gi, "").trim();
            displayText = displayText.replace(/-{2,}PROFILE_SIGNALS-{2,}[\s\S]*?(?:-{2,}END[_\s]*SIGNALS-{2,}|-{2,}END-{2,}|$)/gi, "").trim();
            if (displayText.startsWith("{") && displayText.endsWith("}")) { try { const p = JSON.parse(displayText); displayText = typeof p.analysis === "string" ? p.analysis : ""; } catch {} }
            const tjd = displayText.match(/\n\s*\{[\s\S]*"(?:momentum|option_1|hold|analysis)"[\s\S]*$/);
            if (tjd) { const b = displayText.slice(0, tjd.index).trim(); if (b.length > 20) displayText = b; }

            // Safety enforcement
            if (suggestions && user_id) {
              const isThreat = suggestions.threat_detected === true;
              const isBoundary = suggestions.hold === true && (
                /do not re-?engage|permanent|never|blocked/i.test(String(suggestions.timing ?? ""))
                || /boundary|restraining|blocked|harassment|minor|underage/i.test(String(suggestions.hold_reason ?? ""))
              );
              if (isThreat || isBoundary) {
                await supabase.from("safety_flags").insert({ user_id, contact_id: contact.id || null, flag_type: isThreat ? "threat_detected" : "boundary_hold", ai_analysis: suggestions.analysis || null });
                suggestions.option_1 = null; suggestions.option_2 = null; suggestions.option_3 = null; suggestions.hold = true;
                if (contact.id) { await supabase.from("cockpit_sessions").update({ is_active: false }).eq("contact_id", contact.id).eq("user_id", user_id).eq("is_active", true); }
              }
            }

            // Persist last_known_state snapshot
            if (contact.id && suggestions) {
              const analysisStr = typeof suggestions.analysis === "string" ? suggestions.analysis : null;
              await supabase.from("contacts").update({
                last_known_state: {
                  her_state: analysisStr ? analysisStr.slice(0, 200) : null,
                  momentum: suggestions.momentum ?? null,
                  hold: suggestions.hold ?? false,
                  timing: suggestions.timing ?? null,
                  goal: suggestions.goal ?? null,
                  updated_at: new Date().toISOString(),
                },
              }).eq("id", contact.id);
            }

            // Ask-out readiness
            let askOut = null;
            if (contact.id && suggestions && !suggestions.hold) {
              const { data: cd } = await supabase.from("contacts").select("last_momentum_score, interaction_count, current_vibe, intention, dates_count, her_profile, last_askout_at").eq("id", contact.id).single();
              if (cd) { const r = evaluateAskOutReadiness(cd); if (r.ready) askOut = { ready: true, confidence: r.confidence, reason: r.reason }; }
            }

            // Send final done event with parsed data
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", suggestions, cleanedText: displayText, ask_out: askOut })}\n\n`));
            controller.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Something went wrong";
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    // ═══ NON-STREAMING MODE (existing) ═══
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

    // Process signals in background (if any)
    if (signals.length > 0 && contact.id) {
      appendObservations(contact.id, "cockpit", signals).catch((err) =>
        console.error("[Cockpit] appendObservations error:", err)
      );
    }

    // ALWAYS increment interaction_count — atomic database increment, no race conditions
    if (contact.id) {
      supabase.rpc("increment_interaction_count", { contact_id: contact.id }).then(({ data: newCount, error }) => {
        if (error) {
          console.error("[Cockpit] interaction_count increment error:", error.message);
        } else {
          console.log("[Cockpit] interaction_count now:", newCount, "for contact:", contact.id);
          if (newCount && newCount % 5 === 0) {
            console.log("[Cockpit] Triggering synthesis at interaction:", newCount);
            triggerSynthesis(contact.id!);
          }
        }
      });
    }

    // Parse suggestions from the cleaned response (handles multiple AI output formats)
    let suggestions: Record<string, unknown> | null = null;

    // Try 1: standard delimiters ---SUGGESTIONS--- ... ---END---
    const sugMatch1 = cleanResponse.match(/-{2,}SUGGESTIONS-{2,}\s*([\s\S]*?)\s*-{2,}END-{2,}/i);
    if (sugMatch1) {
      try { suggestions = JSON.parse(stripMarkdownJson(sugMatch1[1])); } catch {}
    }

    // Try 2: opening delimiter but no ---END--- (AI omitted closing)
    if (!suggestions) {
      const sugMatch2 = cleanResponse.match(/-{2,}SUGGESTIONS-{2,}\s*([\s\S]*)/i);
      if (sugMatch2) {
        try { suggestions = JSON.parse(stripMarkdownJson(sugMatch2[1])); } catch {}
      }
    }

    // Try 3: entire response is raw JSON (AI skipped coaching text)
    if (!suggestions) {
      const trimmed = cleanResponse.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(stripMarkdownJson(trimmed));
          if (parsed.momentum !== undefined || parsed.hold !== undefined || parsed.option_1) {
            suggestions = parsed;
          }
        } catch {}
      }
    }

    // Try 4: coaching text followed by trailing JSON (no delimiters)
    if (!suggestions) {
      const trailingJson = cleanResponse.match(/\n\s*(\{[\s\S]*"(?:momentum|option_1|hold|analysis)"[\s\S]*\})\s*$/);
      if (trailingJson) {
        try { suggestions = JSON.parse(stripMarkdownJson(trailingJson[1])); } catch {}
      }
    }

    // Build display text: strip all JSON/delimiter artifacts
    let displayText = cleanResponse;
    // Strip ---SUGGESTIONS--- block (with or without ---END---)
    displayText = displayText.replace(/-{2,}SUGGESTIONS-{2,}[\s\S]*?(?:-{2,}END-{2,}|$)/gi, "").trim();
    // Strip ---PROFILE_SIGNALS--- block
    displayText = displayText.replace(/-{2,}PROFILE_SIGNALS-{2,}[\s\S]*?(?:-{2,}END[_\s]*SIGNALS-{2,}|-{2,}END-{2,}|$)/gi, "").trim();

    // If display text is pure JSON (AI skipped coaching), extract analysis
    if (displayText.startsWith("{") && displayText.endsWith("}")) {
      try {
        const parsed = JSON.parse(displayText);
        displayText = typeof parsed.analysis === "string" ? parsed.analysis : "";
      } catch {
        // Not valid JSON, leave as-is
      }
    }

    // Strip trailing JSON that leaked past delimiters
    const trailingJsonInDisplay = displayText.match(/\n\s*\{[\s\S]*"(?:momentum|option_1|hold|analysis)"[\s\S]*$/);
    if (trailingJsonInDisplay) {
      const before = displayText.slice(0, trailingJsonInDisplay.index).trim();
      if (before.length > 20) displayText = before;
    }

    // ═══ SAFETY ENFORCEMENT ═══
    if (suggestions && user_id) {
      const isThreat = suggestions.threat_detected === true;
      const isBoundaryHold = suggestions.hold === true && (
        /do not re-?engage|permanent|never|blocked/i.test(String(suggestions.timing ?? ""))
        || /boundary|restraining|blocked|harassment|minor|underage/i.test(String(suggestions.hold_reason ?? ""))
      );

      if (isThreat || isBoundaryHold) {
        // Log safety flag
        await supabase.from("safety_flags").insert({
          user_id,
          contact_id: contact.id || null,
          flag_type: isThreat ? "threat_detected" : "boundary_hold",
          ai_analysis: suggestions.analysis || null,
        });
        // Server-side backstop: strip message options even if AI included them
        suggestions.option_1 = null;
        suggestions.option_2 = null;
        suggestions.option_3 = null;
        suggestions.hold = true;
        // Deactivate active cockpit session
        if (contact.id) {
          await supabase
            .from("cockpit_sessions")
            .update({ is_active: false })
            .eq("contact_id", contact.id)
            .eq("user_id", user_id)
            .eq("is_active", true);
        }
      }
    }

    // Persist last_known_state snapshot for next-turn drift detection
    if (contact.id && suggestions) {
      const analysisStr = typeof suggestions.analysis === "string" ? suggestions.analysis : null;
      await supabase.from("contacts").update({
        last_known_state: {
          her_state: analysisStr ? analysisStr.slice(0, 200) : null,
          momentum: suggestions.momentum ?? null,
          hold: suggestions.hold ?? false,
          timing: suggestions.timing ?? null,
          goal: suggestions.goal ?? null,
          updated_at: new Date().toISOString(),
        },
      }).eq("id", contact.id);
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
