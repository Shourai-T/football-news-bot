const [secret, projectRef, extra] = await readNullSeparatedInput();
if (!secret || !projectRef || extra !== undefined) fail("invalid_input");
if (!/^[a-z0-9]{20}$/.test(projectRef)) fail("invalid_project_ref");

let response;
try {
  response = await fetch(
    `https://${projectRef}.supabase.co/functions/v1/scheduled-pipeline`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Scheduled-Secret": secret,
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    },
  );
} catch {
  fail("request_failed");
}

let payload;
try {
  payload = await response.json();
} catch {
  fail(`invalid_response:${response.status}`);
}
if (!response.ok || typeof payload?.status !== "string") {
  fail(`request_failed:${response.status}`);
}
if (!["no_candidate", "draft_sent"].includes(payload.status)) {
  fail(`unexpected_status:${payload.status}`);
}
process.stdout.write(JSON.stringify({
  status: payload.status,
  slotKey: typeof payload.slotKey === "string" ? payload.slotKey : undefined,
}) + "\n");

async function readNullSeparatedInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const values = Buffer.concat(chunks).toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function fail(category) {
  process.stderr.write(`${category}\n`);
  process.exit(1);
}
