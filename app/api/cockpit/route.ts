import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, fetchPrompt, getCurrentTimeContext } from "@/lib/ai";

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
    evolved_read?: string | null;
  };
  user: {
    age: number;
    dating_goal: string;
    reply_speed: string;
    emoji_usage: string;
  };
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
    const { messages, contact, user, images, extract_only, feedback } = body;

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

### Suggestions block (MANDATORY — every response)
Every response MUST end with:

---SUGGESTIONS---
{"confident": {"text": "...", "note": "..."}, "playful": {"text": "...", "note": "..."}, "laid_back": {"text": "...", "note": "..."}, "momentum": 75, "hold": false, "timing": "in 10-20 minutes"}
---END---

If advice is don't text: hold=true, timing=when to text next, still include messages.
NEVER skip this block. The app depends on it.

Your ---SUGGESTIONS--- block is the EXECUTION of your analysis above. Generate it AFTER your coaching, not independently.
- If your analysis says "text her now, match her energy" → hold=false, suggestions match that energy.
- If your analysis says "don't text, let her come to you" → hold=true, timing=when to act.
NEVER generate suggestions that contradict the coaching you just gave. The hold field and the messages must align with your advice.

Fields:
- momentum (0-100): honest. dead conversation = 5-15. ghosting after mistake = 10-20.
- hold (boolean): true = don't text now. false = go ahead.
- timing (string): WHEN to act next. "now", "in 20 min", "tomorrow afternoon", "after she responds". Never repeat current time.

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
${contact.evolved_read ? `
## EVOLVED READ (behavioral profile from past interactions)
${contact.evolved_read}
This is based on ACTUAL behavior, not just her profile. If this contradicts Intel, trust the evolved read.` : ""}
${(() => {
  const msgCount = messages.length;
  if (msgCount >= 10 && intelQuality !== "none") return `
## EVOLVED READ AVAILABLE
You have ${msgCount} messages of conversation history with ${contact.name}. Update your coaching based on:
- How she actually communicates (not just her profile)
- Her response patterns and energy fluctuations
- What topics she lights up about vs what falls flat
When you notice a pattern worth flagging, mention it: "she consistently responds better to laid-back than confident. adjusting."`;
  return "";
})()}

## USER
- Age: ${user.age} | Goal: ${user.dating_goal} | Speed: ${user.reply_speed} | Emoji: ${user.emoji_usage}
${Array.isArray(feedback) && feedback.length > 0 ? `
## PAST RESULTS (what worked/didn't with this contact)
${feedback.slice(-8).map((f) => `- ${f.tone_used} tone → ${f.outcome}${f.user_response ? `: "${f.user_response.slice(0, 80)}"` : ""}`).join("\n")}
Use this data actively. If confident worked before, lean confident. If playful got ghosted, avoid it. Past results are the strongest signal.` : ""}`;

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
    const text = textBlock && "text" in textBlock ? textBlock.text : "";

    let suggestions = null;
    const sugMatch = text.match(/---SUGGESTIONS---\s*([\s\S]*?)\s*---END---/);
    if (sugMatch) {
      try {
        suggestions = JSON.parse(sugMatch[1].trim());
      } catch {
        console.error("Failed to parse suggestions JSON");
      }
    }

    const displayText = text.replace(/---SUGGESTIONS---[\s\S]*?---END---/g, "").trim();

    return Response.json({ text: displayText, suggestions });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Cockpit API error:", msg);
    return Response.json({ error: `Server error: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}
