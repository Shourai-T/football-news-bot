import { execFileSync, spawnSync } from "node:child_process";

const status = execFileSync(
  "npx",
  ["supabase", "status", "-o", "env", "--agent", "no"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);

const values = parseEnv(status);
const apiUrl = requireValue(values, "API_URL");
const serviceRoleKey = requireValue(values, "SERVICE_ROLE_KEY");

const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.supabase.config.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SUPABASE_URL: apiUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    },
  },
);

process.exit(result.status ?? 1);

function parseEnv(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    values.set(match[1], unquote(match[2]));
  }
  return values;
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return value;
}

function requireValue(values, name) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`missing_supabase_status_value:${name}`);
  return value;
}
