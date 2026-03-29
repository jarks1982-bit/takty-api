const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const envPath = path.join(__dirname, ".env.local");
const envFile = fs.readFileSync(envPath, "utf-8");

const env = {};
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  env[key] = value;
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data, error } = await supabase.from("prompts").select("*");

  if (error) {
    console.error("Error querying prompts:", error);
    return;
  }

  console.log(`Found ${data.length} rows:\n`);
  for (const row of data) {
    console.log("-", row.name);
  }
}

main();
