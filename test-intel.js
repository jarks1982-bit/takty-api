const body = {
  images: [],
  contact: {
    name: "Ananya",
    platform: "Hinge",
    notes:
      "Bio says she's 26 from Chicago. Prompts: 'A life goal of mine: Open a small bookstore-cafe that smells like cinnamon and old pages.' 'I'm looking for: Someone who can keep up with my random 2am Wikipedia rabbit holes.' 'The way to win me over: Make me laugh so hard I snort. Bonus points if it's at an inappropriate time.' Photos: hiking at Starved Rock golden hour, group dinner laughing with wine, solo travel at a temple in Kyoto, mirror selfie with a cat on her shoulder. Basics: 5'6, Hindu, moderate drinker, doesn't smoke, has a cat.",
  },
  user: {
    age: 27,
    dating_goal: "exploring",
  },
};

async function main() {
  const response = await fetch("http://localhost:3000/api/intel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

main();
