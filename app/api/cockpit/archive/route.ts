import { NextRequest } from "next/server";
import { supabase } from "@/lib/ai";
import { archiveSessionWithSummary } from "@/lib/coaching-memory";

interface ArchiveRequest {
  contact_id: string;
  user_id: string;
  session_messages: Array<{ role: string; content: string }>;
}

export async function POST(request: NextRequest) {
  try {
    const body: ArchiveRequest = await request.json();
    const { contact_id, user_id, session_messages } = body;

    if (!contact_id || !user_id) {
      return Response.json({ error: "Missing contact_id or user_id" }, { status: 400 });
    }

    // Archive with summary generation (async — generates summary, saves coaching memory, deactivates session)
    await archiveSessionWithSummary(contact_id, user_id, session_messages || []);

    return Response.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Cockpit archive error:", msg);
    return Response.json({ error: `Server error: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}
