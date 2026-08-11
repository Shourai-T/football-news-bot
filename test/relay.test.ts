import { describe, expect, it } from "vitest";
// @ts-expect-error Node types are intentionally excluded from the Worker build.
import { runInThisContext } from "node:vm";
// @ts-expect-error Vite loads the deployed Apps Script source as text for this harness.
import relaySource from "../relay/Code.gs?raw";

const TELEGRAM_BOT_TOKEN = "bot-test-token";
const TELEGRAM_CHAT_ID = "-100123";
const RELAY_SHARED_SECRET = "relay-test-secret";

interface FetchCall {
  url: string;
  options: {
    method: string;
    contentType: string;
    payload: string;
    muteHttpExceptions: boolean;
  };
}

interface RelayHarness {
  doPost: (event: { postData: { contents: string } }) => {
    getContent: () => string;
  };
  fetchCalls: FetchCall[];
}

function createRelayHarness(): RelayHarness {
  const fetchCalls: FetchCall[] = [];
  const createRelay = runInThisContext(`
    (function createRelay(PropertiesService, UrlFetchApp, ContentService) {
      ${relaySource}
      return { doPost: doPost };
    })
  `) as (
    propertiesService: object,
    urlFetchApp: object,
    contentService: object,
  ) => { doPost: RelayHarness["doPost"] };

  const relay = createRelay(
    {
      getScriptProperties: () => ({
        getProperty: (name: string) => ({
          TELEGRAM_BOT_TOKEN,
          TELEGRAM_CHAT_ID,
          RELAY_SHARED_SECRET,
        })[name as "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID" | "RELAY_SHARED_SECRET"],
      }),
    },
    {
      fetch: (url: string, options: FetchCall["options"]) => {
        fetchCalls.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ ok: true, result: true }),
        };
      },
    },
    {
      MimeType: { JSON: "application/json" },
      createTextOutput: (content: string) => ({
        getContent: () => content,
        setMimeType() {
          return this;
        },
      }),
    },
  );

  return { ...relay, fetchCalls };
}

function post(harness: RelayHarness, request: Record<string, unknown>): Record<string, unknown> {
  const response = harness.doPost({ postData: { contents: JSON.stringify(request) } });
  return JSON.parse(response.getContent()) as Record<string, unknown>;
}

describe("Apps Script Telegram relay", () => {
  it.each([
    ["missing", undefined],
    ["mismatched", "-100999"],
    ["non-string", -100123],
  ])("rejects %s top-level chat metadata before calling Telegram", (_case, chatId) => {
    const harness = createRelayHarness();
    const request: Record<string, unknown> = {
      secret: RELAY_SHARED_SECRET,
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-7", text: "Approved" },
    };
    if (chatId !== undefined) {
      request.chatId = chatId;
    }

    expect(post(harness, request)).toEqual({ ok: false, error: "invalid_chat" });
    expect(harness.fetchCalls).toEqual([]);
  });

  it("relays a matching chat-scoped callback only to answerCallbackQuery", () => {
    const harness = createRelayHarness();

    expect(post(harness, {
      secret: RELAY_SHARED_SECRET,
      chatId: TELEGRAM_CHAT_ID,
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-7", text: "Approved" },
    })).toEqual({
      ok: true,
      status: 200,
      body: JSON.stringify({ ok: true, result: true }),
    });
    expect(harness.fetchCalls).toEqual([{
      url: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      options: {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ callback_query_id: "callback-7", text: "Approved" }),
        muteHttpExceptions: true,
      },
    }]);
  });
});
