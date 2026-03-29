import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function fetchPrompt(name: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("prompts")
    .select("content")
    .eq("name", name)
    .eq("is_active", true)
    .single();

  if (error || !data) return null;
  return data.content;
}

export function stripMarkdownJson(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

export function getCurrentTimeContext(): string {
  // Build time string manually for reliability on serverless
  const now = new Date();
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const day = days[ct.getDay()];
  const month = months[ct.getMonth()];
  const date = ct.getDate();
  const year = ct.getFullYear();
  const h = ct.getHours();
  const m = ct.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `Current time: ${day}, ${month} ${date}, ${year} at ${hour}:${m} ${ampm} CT`;
}
