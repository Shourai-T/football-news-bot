const [botToken, webhookSecret, projectRef, extra] = await readNullSeparatedInput();
if (!botToken || !webhookSecret || !projectRef || extra !== undefined) {
  fail("invalid_input");
}
if (!/^[a-z0-9]{20}$/.test(projectRef)) fail("invalid_project_ref");

const apiRoot = `https://api.telegram.org/bot${botToken}`;
const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/telegram-webhook`;
const configured = await telegramRequest(`${apiRoot}/setWebhook`, {
  url: webhookUrl,
  secret_token: webhookSecret,
  allowed_updates: ["message", "callback_query"],
});
if (configured.result !== true) fail("set_webhook_failed");

const info = await telegramRequest(`${apiRoot}/getWebhookInfo`, {});
const result = info.result;
if (
  typeof result !== "object" ||
  result === null ||
  result.url !== webhookUrl ||
  !Number.isSafeInteger(result.pending_update_count)
) {
  fail("invalid_webhook_info");
}
if (result.pending_update_count !== 0 || "last_error_date" in result) {
  fail("webhook_delivery_unhealthy");
}
process.stdout.write(JSON.stringify({
  status: "ok",
  url: result.url,
  pendingUpdateCount: result.pending_update_count,
  hasRecentDeliveryError: "last_error_date" in result,
}) + "\n");

async function telegramRequest(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    fail("telegram_network_error");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`telegram_invalid_response:${response.status}`);
  }
  if (!response.ok || payload?.ok !== true) {
    fail(`telegram_api_error:${response.status}`);
  }
  return payload;
}

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
