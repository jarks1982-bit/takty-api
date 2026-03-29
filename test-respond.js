const body = {
  her_message:
    "haha the fork to CIA pipeline is wild. mine was looking up how many ants exist and somehow ending up on cold war submarine disasters at 3am",
  time_ago: "4 minutes",
  contact: {
    name: "Ananya",
    platform: "Hinge",
    her_age_range: "mid-20s",
    dates_count: 0,
    vibe: "hot",
    intention: "exploring",
    her_style: "quick replier",
    notes:
      "Into hiking, just got back from Japan, has a cat named Mochi, wants someone who can keep up with 2am Wikipedia rabbit holes",
    intel_data: {},
  },
  user: {
    age: 27,
    dating_goal: "exploring",
    reply_speed: "within an hour",
    emoji_usage: "sometimes",
  },
};

async function main() {
  const response = await fetch("http://localhost:3000/api/analyze-response", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

main();
