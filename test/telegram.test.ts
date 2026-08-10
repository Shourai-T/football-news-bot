import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram";

const draft = {
  id: 42,
  body: "Club confirms the transfer.",
  canonicalUrl: "https://club.test/news/transfer",
};

beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TelegramClient", () => {
  it("sends a stored draft with compact approval callbacks", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 314 } });
    };
    const telegram = new TelegramClient(
      { botToken: "telegram-test-secret", chatId: "-100123" },
      fetcher,
    );

    await expect(telegram.sendDraft(draft)).resolves.toBe(314);
    expect(bodies[0]).toMatchObject({
      chat_id: "-100123",
      text: `${draft.body}\n\nSource: ${draft.canonicalUrl}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: "a:42" },
            { text: "Reject", callback_data: "r:42" },
          ],
        ],
      },
    });
  });

  it("acknowledges a callback through answerCallbackQuery", async () => {
    const calls: Array<{ input: RequestInfo | URL; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: true });
    };
    const telegram = new TelegramClient(
      { botToken: "telegram-test-secret", chatId: "-100123" },
      fetcher,
    );

    await telegram.answerCallback("callback-7", "Approved");

    expect(String(calls[0]?.input).endsWith("/answerCallbackQuery")).toBe(true);
    expect(calls[0]?.body).toEqual({ callback_query_id: "callback-7", text: "Approved" });
  });

  it("edits a draft to its final state and removes buttons", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 314 } });
    };
    const telegram = new TelegramClient(
      { botToken: "telegram-test-secret", chatId: "-100123" },
      fetcher,
    );

    await telegram.editDraftState(314, `${draft.body}\n\nSource: ${draft.canonicalUrl}`, "approved");

    expect(bodies[0]).toEqual({
      chat_id: "-100123",
      message_id: 314,
      text: `${draft.body}\n\nSource: ${draft.canonicalUrl}\n\nStatus: APPROVED`,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("maps Telegram API errors without exposing provider data or secrets", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async () =>
      Response.json(
        { ok: false, description: "provider payload must stay private" },
        { status: 400 },
      );
    const telegram = new TelegramClient(
      { botToken: "telegram-test-secret", chatId: "-100123" },
      fetcher,
    );

    await expect(telegram.sendDraft(draft)).rejects.toThrow("telegram_api_error:400");
    await expect(telegram.sendDraft(draft)).rejects.not.toThrow("provider payload must stay private");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("uses an exact eight-second timeout for every provider call", async () => {
    const timeout = vi.mocked(AbortSignal.timeout);
    const fetcher: typeof fetch = async (input) =>
      Response.json(
        String(input).endsWith("/sendMessage")
          ? { ok: true, result: { message_id: 314 } }
          : { ok: true, result: true },
      );
    const telegram = new TelegramClient(
      { botToken: "telegram-test-secret", chatId: "-100123" },
      fetcher,
    );

    await telegram.sendDraft(draft);
    await telegram.answerCallback("callback-7", "Approved");
    await telegram.editDraftState(314, draft.body, "approved");

    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenNthCalledWith(1, 8_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 8_000);
    expect(timeout).toHaveBeenNthCalledWith(3, 8_000);
  });
});
