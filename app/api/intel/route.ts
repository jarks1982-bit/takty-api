import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, fetchPrompt, stripMarkdownJson, getCurrentTimeContext } from "@/lib/ai";

interface User {
  age: number;
  dating_goal: string;
  reply_speed: string;
  emoji_usage: string;
}

interface IntelRequest {
  images: string[];
  contact: Record<string, unknown>;
  user: User;
}

export async function POST(request: NextRequest) {
  try {
    const body: IntelRequest = await request.json();
    const { images, contact, user } = body;

    if (!images || !contact || !user) {
      return Response.json(
        { error: "Missing required fields: images, contact, user" },
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

    const taskPrompt = await fetchPrompt("intel_report");
    if (!taskPrompt) {
      return Response.json(
        { error: "Failed to fetch intel_report prompt" },
        { status: 500 }
      );
    }

    const detectMediaType = (b64: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" => {
      if (b64.startsWith("/9j/")) return "image/jpeg";
      if (b64.startsWith("iVBOR")) return "image/png";
      if (b64.startsWith("UklGR")) return "image/webp";
      if (b64.startsWith("R0lGO")) return "image/gif";
      return "image/jpeg";
    };

    const contentBlocks: Anthropic.ImageBlockParam[] = images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: detectMediaType(img),
        data: img,
      },
    }));

    const textBlock: Anthropic.TextBlockParam = {
      type: "text",
      text: `${taskPrompt}

## User Context
- Age: ${user.age}
- Dating Goal: ${user.dating_goal}
- Reply Speed: ${user.reply_speed}
- Emoji Usage: ${user.emoji_usage}

## Known Contact Info
${JSON.stringify(contact, null, 2)}${getCurrentTimeContext()}`,
    };

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: personalityPrompt,
      messages: [
        {
          role: "user",
          content: [...contentBlocks, textBlock],
        },
      ],
    });

    const responseText = response.content.find((block) => block.type === "text");
    const text = responseText && "text" in responseText ? responseText.text : "";

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripMarkdownJson(text));
    } catch {
      console.error("Intel: Failed to parse LLM JSON:", text.slice(0, 500));
      return Response.json(
        { error: "AI returned an invalid response. Try again." },
        { status: 502 }
      );
    }

    // Build initial her_profile from Intel analysis
    const initialProfile = {
      observations: [{
        type: "pattern",
        direction: "new",
        evidence: `Initial intel: ${(parsed as Record<string, unknown>).the_read ? String(((parsed as Record<string, unknown>).the_read as Array<Record<string, unknown>>)?.[0]?.value ?? "unknown").slice(0, 100) : "unknown"}`,
        source: "screenshot",
        trust: "high",
        timestamp: new Date().toISOString(),
      }],
      personality: {
        observed_behaviors: ((parsed as Record<string, unknown>).flags as Record<string, unknown>)?.green ? ((parsed as Record<string, unknown>).flags as Record<string, string[]>).green.slice(0, 3) : [],
        humor_style: ((parsed as Record<string, unknown>).the_read as Array<Record<string, unknown>>)?.[1]?.value ?? null,
        confidence: 0.5,
      },
      interests: {
        confirmed: (((parsed as Record<string, unknown>).hooks as Array<Record<string, unknown>>) ?? [])
          .filter((h) => h.strength === "HIGH")
          .map((h) => ({ topic: h.item, mentions: 1, engages: null })),
        mentioned_once: (((parsed as Record<string, unknown>).hooks as Array<Record<string, unknown>>) ?? [])
          .filter((h) => h.strength !== "HIGH")
          .map((h) => h.item),
        avoid: [],
      },
      communication: null,
      what_works: null,
      attachment_style: null,
      emotional_depth: null,
      conflict_style: null,
      love_language_signals: null,
      relationship_patterns: null,
      observation_count: 1,
      synthesis_count: 0,
    };

    return Response.json({ ...parsed, _her_profile: initialProfile });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Intel API error:", msg);
    return Response.json(
      { error: `Server error: ${msg.slice(0, 200)}` },
      { status: 500 }
    );
  }
}
