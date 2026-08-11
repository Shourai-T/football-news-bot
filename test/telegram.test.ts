import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram";

const RELAY_URL = "https://relay.test/telegram";
const RELAY_SECRET = "relay-test-secret";
const CHAT_ID = "-100123";
const draft = {
  id: 42,
  body: "Club confirms the transfer.",
  canonicalUrl: "https://club.test/news/transfer",
};

function relayResponse(body: unknown, status = 200): Response {
  return Response.json({
    ok: status >= 200 && status < 300,
    status,
    body: JSON.stringify(body),
  });
}

function client(fetcher: typeof fetch, relayUrl = RELAY_URL): TelegramClient {
  return new TelegramClient({ relayUrl, relaySecret: RELAY_SECRET, chatId: CHAT_ID }, fetcher);
}

function relayBody(init: RequestInit | undefined): {
  secret: string;
  method: string;
  body: Record<string, unknown>;
} {
  return JSON.parse(String(init?.body));
}

beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TelegramClient", () => {
  it("rejects Telegram relay URLs before any request", () => {
    const fetcher = vi.fn<typeof fetch>();

    for (const relayUrl of [
      "https://api.telegram.org",
      "https://api.telegram.org/bot/token/sendMessage",
      "https://api.telegram.org/?method=getMe",
      "https://api.telegram.org./bot/token/sendMessage",
      "http://api.telegram.org/bot/token/sendMessage",
    ]) {
      expect(() => client(fetcher, relayUrl)).toThrow("telegram_relay_configuration_error");
      expect(() => client(fetcher, relayUrl)).not.toThrow(relayUrl);
    }

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the initial Telegram draft within the text limit after its source suffix", async () => {
    const bodies: Array<{ text: string }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(relayBody(init).body as { text: string });
      return relayResponse({ ok: true, result: { message_id: 314 } });
    };

    await client(fetcher).sendDraft({
      ...draft,
      body: "x".repeat(3_000),
      canonicalUrl: `https://club.test/${"a".repeat(2_000)}`,
    });

    expect(bodies[0]!.text.length).toBeLessThanOrEqual(4_096);
  });

  it("keeps the final Telegram edit within the text limit after its status suffix", async () => {
    const bodies: Array<{ text: string }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(relayBody(init).body as { text: string });
      return relayResponse({ ok: true, result: true });
    };

    await client(fetcher).editDraftState(314, "x".repeat(4_096), "rejected");

    expect(bodies[0]!.text.length).toBeLessThanOrEqual(4_096);
  });

  it("posts a stored draft to the relay with a signed sendMessage envelope", async () => {
    const calls: Array<{ input: RequestInfo | URL; envelope: ReturnType<typeof relayBody> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, envelope: relayBody(init) });
      return relayResponse({ ok: true, result: { message_id: 314 } });
    };

    await expect(client(fetcher).sendDraft(draft)).resolves.toBe(314);

    expect(String(calls[0]?.input)).toBe(RELAY_URL);
    expect(String(calls[0]?.input)).not.toContain(RELAY_SECRET);
    expect(String(calls[0]?.input)).not.toContain("sendMessage");
    expect(calls[0]?.envelope).toEqual({
      secret: RELAY_SECRET,
      method: "sendMessage",
      body: {
        chat_id: CHAT_ID,
        text: `${draft.body}\n\nSource: ${draft.canonicalUrl}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: "a:42" },
              { text: "Reject", callback_data: "r:42" },
            ],
          ],
        },
      },
    });
  });

  it("acknowledges a callback through a relay answerCallbackQuery envelope", async () => {
    const calls: Array<{ input: RequestInfo | URL; envelope: ReturnType<typeof relayBody> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, envelope: relayBody(init) });
      return relayResponse({ ok: true, result: true });
    };

    await client(fetcher).answerCallback("callback-7", "Approved");

    expect(String(calls[0]?.input)).toBe(RELAY_URL);
    expect(calls[0]?.envelope).toEqual({
      secret: RELAY_SECRET,
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-7", text: "Approved" },
    });
  });

  it("edits a draft to its final state and removes buttons", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(relayBody(init).body);
      return relayResponse({ ok: true, result: true });
    };

    await client(fetcher).editDraftState(314, `${draft.body}\n\nSource: ${draft.canonicalUrl}`, "approved");

    expect(bodies[0]).toEqual({
      chat_id: CHAT_ID,
      message_id: 314,
      text: `${draft.body}\n\nSource: ${draft.canonicalUrl}\n\nStatus: APPROVED`,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("rejects a malformed relay envelope without exposing its body", async () => {
    const privateRelayBody = "relay response must stay private";
    const fetcher: typeof fetch = async () => Response.json({ ok: true, status: "200", body: privateRelayBody });

    await expect(client(fetcher).sendDraft(draft)).rejects.toThrow("telegram_invalid_response");
    await expect(client(fetcher).sendDraft(draft)).rejects.not.toThrow(privateRelayBody);
  });

  it("rejects a relay denial without requiring provider response fields", async () => {
    const fetcher: typeof fetch = async () => Response.json({ ok: false });

    await expect(client(fetcher).sendDraft(draft)).rejects.toThrow("telegram_relay_error");
  });

  it("preserves a nested Telegram HTTP 400 without exposing its response body", async () => {
    const privateProviderBody = "provider payload must stay private";
    const fetcher: typeof fetch = async () => relayResponse({ ok: false, description: privateProviderBody }, 400);

    await expect(client(fetcher).sendDraft(draft)).rejects.toThrow("telegram_api_error:400");
    await expect(client(fetcher).sendDraft(draft)).rejects.not.toThrow(privateProviderBody);
  });

  it("classifies an abort while reading the relay response body", async () => {
    const response = Response.json({});
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("aborted", "AbortError"));
    const fetcher: typeof fetch = async () => response;

    await expect(client(fetcher).sendDraft(draft)).rejects.toThrow("telegram_timeout");
  });

  it("uses an exact eight-second timeout for every relay call", async () => {
    const timeout = vi.mocked(AbortSignal.timeout);
    const fetcher: typeof fetch = async (_input, init) => {
      const { method } = relayBody(init);
      return relayResponse(method === "sendMessage" ? { ok: true, result: { message_id: 314 } } : { ok: true, result: true });
    };
    const telegram = client(fetcher);

    await telegram.sendDraft(draft);
    await telegram.answerCallback("callback-7", "Approved");
    await telegram.editDraftState(314, draft.body, "approved");

    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenNthCalledWith(1, 8_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 8_000);
    expect(timeout).toHaveBeenNthCalledWith(3, 8_000);
  });
});
