import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase, anthropic, fetchPrompt, stripMarkdownJson, getCurrentTimeContext } from "@/lib/ai";
import { extractSignals, appendObservations, buildProfileContext, triggerSynthesis, PROFILE_SIGNALS_INSTRUCTION } from "@/lib/profile-engine";

interface Contact {
  name: string;
  platform: string;
  her_age_range: string;
  dates_count: number;
  vibe: string;
  intention: string;
  her_style: string;
  notes: string;
  intel_data: Record<string, unknown>;
  her_profile?: Record<string, unknown> | null;
}

interface User {
  age: number;
  dating_goal: string;
  reply_speed: string;
  emoji_usage: string;
}

interface AnalyzeResponseRequest {
  her_message?: string;
  time_ago?: string;
  images?: string[];
  contact: Contact & { id?: string };
  user: User;
}

// Detect image type from base64 header bytes
function detectMediaType(base64: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGO")) return "image/gif";
  return "image/jpeg"; // default fallback
}

export async function POST(request: NextRequest) {
  try {
    const body: AnalyzeResponseRequest = await request.json();
    const { her_message, time_ago, images, contact, user } = body;

    const hasImages = Array.isArray(images) && images.length > 0;

    if (!her_message && !hasImages) {
      return Response.json(
        { error: "Provide her_message or images" },
        { status: 400 }
      );
    }

    if (!contact || !user) {
      return Response.json(
        { error: "Missing contact or user" },
        { status: 400 }
      );
    }

    const personalityPrompt = await fetchPrompt("system_personality");
    if (!personalityPrompt) {
      return Response.json(
        { error: "Failed to fetch system personality prompt" },
        { status: 500 }
      );
    }

    const taskPrompt = await fetchPrompt("message_lab_respond");
    if (!taskPrompt) {
      return Response.json(
        { error: "Failed to fetch prompt for situation: respond" },
        { status: 500 }
      );
    }

    const screenshotInstruction = hasImages
      ? `\n\n## Screenshot Context\nThe user has uploaded screenshots of their text conversation. Read the messages visible in the screenshots. Identify her most recent message and the conversation flow. Use what you see to assess energy, timing, and generate responses that directly continue this specific conversation. Reference specific things she said.`
      : "";

    const herMessageSection = her_message
      ? `\n## Her Message\n"${her_message}"\n\n## Time Since Her Message\n${time_ago || "unknown"}`
      : hasImages
      ? `\n## Her Message\n(Extract from the uploaded conversation screenshots)`
      : "";

    const textContent = `${taskPrompt}${screenshotInstruction}${herMessageSection}

## User Context
- Age: ${user.age}
- Dating Goal: ${user.dating_goal}
- Reply Speed: ${user.reply_speed}
- Emoji Usage: ${user.emoji_usage}

## Contact Context
- Name: ${contact.name}
- Platform: ${contact.platform}
- Age Range: ${contact.her_age_range}
- Dates Count: ${contact.dates_count}
- Vibe: ${contact.vibe}
- Intention: ${contact.intention}
- Her Style: ${contact.her_style}
- Notes: ${contact.notes}
- Intel Data: ${JSON.stringify(contact.intel_data)}
${buildProfileContext(contact.her_profile ?? null) ? `\n## BEHAVIORAL PROFILE\n${buildProfileContext(contact.her_profile ?? null)}` : ""}${getCurrentTimeContext()}
${PROFILE_SIGNALS_INSTRUCTION}`;

    // Build content blocks: images first (if any), then text
    const contentBlocks: Anthropic.ContentBlockParam[] = [];

    if (hasImages) {
      for (const img of images) {
        contentBlocks.push({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: detectMediaType(img),
            data: img,
          },
        });
      }
    }

    contentBlocks.push({ type: "text" as const, text: textContent });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: personalityPrompt,
      messages: [{ role: "user", content: contentBlocks }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const rawText = textBlock && "text" in textBlock ? textBlock.text : "";

    // Extract profile signals
    const { cleanResponse: cleanedText, signals } = extractSignals(rawText);
    if (signals.length > 0 && contact.id) {
      const source = hasImages ? "screenshot" : "cockpit";
      appendObservations(contact.id, source, signals).then((count) => {
        if (count > 0 && count % 5 === 0) triggerSynthesis(contact.id!);
      });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripMarkdownJson(cleanedText));
    } catch (parseErr) {
      console.error("Failed to parse LLM response as JSON:", cleanedText.slice(0, 500));
      return Response.json(
        { error: "AI returned an invalid response. Try again." },
        { status: 502 }
      );
    }

    // Save vibe + energy + momentum to contact — guard each field
    if (contact.id) {
      const updates: Record<string, unknown> = {};
      if (parsed.vibe && typeof parsed.vibe === "object") {
        const vibe = parsed.vibe as Record<string, unknown>;
        if (vibe.label) updates.current_vibe = vibe.label;
        if (vibe.detail) updates.last_vibe_detail = vibe.detail;
      }
      if (parsed.energy && typeof parsed.energy === "object") {
        const energy = parsed.energy as Record<string, unknown>;
        if (energy.level) updates.last_energy_level = energy.level;
      }
      if (parsed.momentum && typeof parsed.momentum === "object") {
        const momentum = parsed.momentum as Record<string, unknown>;
        if (momentum.score != null) updates.last_momentum_score = momentum.score;
      }
      if (Object.keys(updates).length > 0) {
        await supabase.from("contacts").update(updates).eq("id", contact.id);
      }
    }

    return Response.json(parsed);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Analyze response API error:", msg);
    return Response.json(
      { error: `Server error: ${msg.slice(0, 200)}` },
      { status: 500 }
    );
  }
}
