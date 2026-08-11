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
  chatId: string;
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
      chatId: CHAT_ID,
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

  it.each([302, 303])("follows a Google Apps Script %s redirect with a bodyless GET", async (status) => {
    const redirectUrl = "https://script.googleusercontent.com/macros/echo?user_content_key=opaque";
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return calls.length === 1
        ? new Response(null, { status, headers: { location: redirectUrl } })
        : relayResponse({ ok: true, result: { id: 12345 } });
    };

    await expect(client(fetcher).checkHealth()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe(RELAY_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(relayBody(calls[0]?.init).secret).toBe(RELAY_SECRET);
    expect(calls[1]).toEqual({
      input: redirectUrl,
      init: {
        method: "GET",
        redirect: "error",
        signal: calls[0]?.init?.signal,
      },
    });
  });

  it.each([
    [301, "https://script.googleusercontent.com/macros/echo"],
    [307, "https://script.googleusercontent.com/macros/echo"],
    [302, "http://script.googleusercontent.com/macros/echo"],
    [302, "https://script.googleusercontent.com.evil.test/macros/echo"],
    [302, "https://sub.script.googleusercontent.com/macros/echo"],
    [302, "https://script.googleusercontent.com./macros/echo"],
    [302, "https://user@script.googleusercontent.com/macros/echo"],
  ])("rejects relay redirect status %s and target %s", async (status, location) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, {
      status,
      headers: { location },
    }));

    await expect(client(fetcher).checkHealth()).rejects.toThrow("telegram_relay_redirect_error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect without a location before a second fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }));

    await expect(client(fetcher).checkHealth()).rejects.toThrow("telegram_relay_redirect_error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redacts a rejected fetch after a valid relay redirect", async () => {
    const createFetcher = () => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://script.googleusercontent.com/macros/echo?private=value" },
      }))
      .mockRejectedValueOnce(new TypeError("private transport detail"));

    await expect(client(createFetcher()).checkHealth()).rejects.toMatchObject({
      message: "telegram_network_error",
      transport: "fetch_rejected",
      phase: "relay_redirect",
    });
    await expect(client(createFetcher()).checkHealth()).rejects.not.toThrow("private transport detail");
  });

  it("classifies a timeout during the redirected GET", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://script.googleusercontent.com/macros/echo" },
      }))
      .mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"));

    await expect(client(fetcher).checkHealth()).rejects.toMatchObject({
      message: "telegram_timeout",
      transport: "timeout",
      phase: "relay_redirect",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies and redacts an initial relay POST rejection", async () => {
    const privateDetail = "private initial fetch detail";
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateDetail));

    await expect(client(fetcher).checkHealth()).rejects.toMatchObject({
      message: "telegram_network_error",
      transport: "fetch_rejected",
      phase: "relay_post",
    });
    await expect(client(fetcher).checkHealth()).rejects.not.toThrow(privateDetail);
  });

  it("classifies an initial relay POST timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("request timed out", "TimeoutError"),
    );

    await expect(client(fetcher).checkHealth()).rejects.toMatchObject({
      message: "telegram_timeout",
      transport: "timeout",
      phase: "relay_post",
    });
  });

  it("does not classify an envelope construction error as relay_post", async () => {
    const privateError = new Error("private envelope detail");
    const fetcher = vi.fn<typeof fetch>();
    const telegram = new TelegramClient({
      relayUrl: RELAY_URL,
      relaySecret: RELAY_SECRET,
      get chatId(): string {
        throw privateError;
      },
    }, fetcher);

    let caught: unknown;
    try {
      await telegram.checkHealth();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(privateError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a second redirect without making a third request", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://script.googleusercontent.com/macros/echo" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test/steal" },
      }));

    await expect(client(fetcher).checkHealth()).rejects.toThrow("telegram_relay_error");
    expect(fetcher).toHaveBeenCalledTimes(2);
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
      chatId: CHAT_ID,
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
