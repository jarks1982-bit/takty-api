interface AskOutReadiness {
  ready: boolean;
  confidence: number;
  reason: string;
  blockers: string[];
}

export function evaluateAskOutReadiness(contact: {
  last_momentum_score?: number | null;
  interaction_count?: number | null;
  current_vibe?: string | null;
  intention?: string | null;
  dates_count?: number | null;
  her_profile?: Record<string, unknown> | null;
  last_askout_at?: string | null;
}): AskOutReadiness {
  let confidence = 0;
  const blockers: string[] = [];
  const momentum = contact.last_momentum_score ?? 50;
  const interactions = contact.interaction_count ?? 0;
  const vibe = (contact.current_vibe ?? "").toLowerCase();
  const intent = (contact.intention ?? "").toLowerCase();
  const dates = contact.dates_count ?? 0;
  const profile = contact.her_profile as Record<string, unknown> | null;

  // Hard blockers
  if (momentum < 30) blockers.push("momentum is cooling");
  if (interactions < 3) blockers.push("not enough conversation yet");
  if (vibe === "cooling") blockers.push("energy is dropping");
  if (contact.last_askout_at) {
    const hoursSince = (Date.now() - new Date(contact.last_askout_at).getTime()) / 3600000;
    if (hoursSince < 48) blockers.push("already asked recently — wait for her response");
  }

  // Positive signals
  if (momentum >= 70) confidence += 30;
  if (interactions >= 5) confidence += 20;
  if (vibe === "hot" || vibe === "warm" || vibe === "building") confidence += 15;
  if (dates === 0 && interactions >= 8) confidence += 10;
  if (profile?.synthesis_count && (profile.synthesis_count as number) >= 1) confidence += 10;
  if (profile?.observations && Array.isArray(profile.observations) && profile.observations.length > 0) confidence += 5;

  // Intent modifiers
  if (intent === "casual") confidence += 10;
  if (intent === "serious") confidence -= 10;
  if (intent === "vip") confidence -= 15;
  if (intent === "unclear") confidence -= 15;

  const hasHardBlockers = blockers.length > 0;
  const ready = confidence >= 40 && !hasHardBlockers;

  let reason = "";
  if (hasHardBlockers) {
    reason = blockers[0];
  } else if (confidence >= 70) {
    reason = "conversation is in a great spot to ask her out";
  } else if (confidence >= 40) {
    reason = "getting there — momentum is building";
  } else {
    reason = "not quite ready yet";
  }

  return { ready, confidence: Math.max(0, Math.min(100, confidence)), reason, blockers };
}
