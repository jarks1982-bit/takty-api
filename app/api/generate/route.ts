import { NextRequest } from "next/server";
import { supabase, anthropic, fetchPrompt, stripMarkdownJson, getCurrentTimeContext } from "@/lib/ai";
import { buildProfileContext } from "@/lib/profile-engine";

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

interface GenerateRequest {
  situation: string;
  contact: Contact & { id?: string };
  user: User;
  enrichment?: {
    momentum?: number;
    readiness_confidence?: number;
    recent_messages?: string[];
    profile_context?: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: GenerateRequest = await request.json();
    const { situation, contact, user, enrichment } = body;

    if (!situation || !contact || !user) {
      return Response.json(
        { error: "Missing required fields: situation, contact, user" },
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

    const taskPrompt = await fetchPrompt(`message_lab_${situation}`);
    if (!taskPrompt) {
      return Response.json(
        { error: `Failed to fetch prompt for situation: ${situation}` },
        { status: 500 }
      );
    }

    const userMessage = `${taskPrompt}

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
${buildProfileContext(contact.her_profile ?? null) ? `\n## What Suavo Knows About Her\n${buildProfileContext(contact.her_profile ?? null)}` : ""}${enrichment ? `\n## Conversation Context${enrichment.momentum ? `\n- Current momentum: ${enrichment.momentum}/100` : ""}${enrichment.readiness_confidence ? `\n- Ask-out readiness: ${enrichment.readiness_confidence}%` : ""}${enrichment.recent_messages?.length ? `\n- Recent exchange:\n${enrichment.recent_messages.join("\n")}` : ""}${enrichment.profile_context ? `\n- Profile: ${enrichment.profile_context}` : ""}` : ""}${getCurrentTimeContext()}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: personalityPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text : "";
    const parsed = JSON.parse(stripMarkdownJson(text));

    // Track ask-out timestamp
    if (situation === "ask" && contact.id) {
      await supabase.from("contacts").update({ last_askout_at: new Date().toISOString() }).eq("id", contact.id);
    }

    return Response.json(parsed);
  } catch (error) {
    console.error("Generate API error:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
