const ALLOWED_METHODS = new Set([
  "getMe",
  "sendMessage",
  "answerCallbackQuery",
  "editMessageText",
]);

function doPost(e) {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty("TELEGRAM_BOT_TOKEN");
  const chatId = properties.getProperty("TELEGRAM_CHAT_ID");
  const sharedSecret = properties.getProperty("RELAY_SHARED_SECRET");

  let request;
  try {
    request = JSON.parse(e && e.postData && e.postData.contents);
  } catch {
    return jsonResponse({ ok: false });
  }

  if (
    !token ||
    !chatId ||
    !sharedSecret ||
    !isRecord(request) ||
    request.secret !== sharedSecret ||
    typeof request.method !== "string" ||
    !ALLOWED_METHODS.has(request.method) ||
    !isRecord(request.body) ||
    ("chat_id" in request.body && String(request.body.chat_id) !== chatId)
  ) {
    return jsonResponse({ ok: false });
  }

  let response;
  try {
    response = UrlFetchApp.fetch(
      `https://api.telegram.org/bot${token}/${request.method}`,
      {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(request.body),
        muteHttpExceptions: true,
      },
    );
  } catch {
    return jsonResponse({ ok: false });
  }
  const status = response.getResponseCode();

  return jsonResponse({
    ok: status >= 200 && status < 300,
    status,
    body: response.getContentText(),
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
