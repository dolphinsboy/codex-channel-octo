/**
 * Tests for StreamRelay — typing heartbeat, message splitting, plain sendMessage delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { splitMessage, type ImageDeliveryPart } from "../stream-relay.js";
import { TurnContext } from "../turn-context.js";
import type { PreparedImage } from "../media-outbound.js";

// ─── splitMessage ───────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single segment when text fits", () => {
    const text = "hello world";
    expect(splitMessage(text, 100)).toEqual(["hello world"]);
  });

  it("returns single segment when text equals maxChars exactly", () => {
    const text = "a".repeat(3500);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits at paragraph boundary (\\n\\n)", () => {
    const para1 = "a".repeat(1000);
    const para2 = "b".repeat(1000);
    const para3 = "c".repeat(1000);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const segments = splitMessage(text, 2500);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0]).toContain(para1);
    expect(segments.join("")).toBe(text);
  });

  it("splits at newline when no paragraph break", () => {
    const line1 = "a".repeat(2000);
    const line2 = "b".repeat(2000);
    const text = `${line1}\n${line2}`;
    const segments = splitMessage(text, 2500);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe(`${line1}\n`);
    expect(segments[1]).toBe(line2);
  });

  it("splits at space when no newline", () => {
    const word1 = "a".repeat(2000);
    const word2 = "b".repeat(2000);
    const text = `${word1} ${word2}`;
    const segments = splitMessage(text, 2500);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe(`${word1} `);
    expect(segments[1]).toBe(word2);
  });

  it("hard cuts when no natural boundary", () => {
    const text = "a".repeat(7000);
    const segments = splitMessage(text, 3500);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe("a".repeat(3500));
    expect(segments[1]).toBe("a".repeat(3500));
  });

  it("handles empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("reassembles to original for multi-segment split", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} content.`).join("\n\n");
    const segments = splitMessage(text, 100);
    expect(segments.join("")).toBe(text);
  });

  it("throws on maxChars <= 0", () => {
    expect(() => splitMessage("hello", 0)).toThrow("maxChars must be >= 1");
    expect(() => splitMessage("hello", -5)).toThrow("maxChars must be >= 1");
  });

  it("works with maxChars = 1", () => {
    const segments = splitMessage("abc", 1);
    expect(segments).toEqual(["a", "b", "c"]);
  });

  it("splitMessage does not break surrogate pairs on hard cut", () => {
    // 👨‍👩‍👧‍👦 is a family emoji (ZWJ sequence, 11 UTF-16 code units)
    const emoji = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const padding = "a".repeat(10);
    const text = padding + emoji;
    // Cut at a position that would fall inside the emoji sequence
    const segments = splitMessage(text, padding.length + 2);
    // Reassembly must produce the original
    expect(segments.join("")).toBe(text);
  });

  it("splitMessage handles lone surrogate gracefully", () => {
    // A string with a high surrogate at the end (malformed but shouldn't crash)
    const text = "hello\uD83D";
    const segments = splitMessage(text, 3);
    expect(segments.join("")).toBe(text);
  });

  it("does not split surrogate pairs on hard cut", () => {
    // 😀 = U+1F600 = 😀 (2 code units)
    const emoji = "😀";
    // Fill to force a hard cut right at a surrogate pair boundary
    const filler = "a".repeat(9); // 9 + 2 = 11 code units, maxChars=10 would cut inside emoji
    const text = filler + emoji;  // 11 code units
    const segments = splitMessage(text, 10);
    // Should NOT split the surrogate pair — back up to 9
    expect(segments[0]).toBe(filler);
    expect(segments[1]).toBe(emoji);
    expect(segments.join("")).toBe(text);
  });
});

// ─── Shared mock state via vi.hoisted ───────────────────────────────────────

interface ApiCall {
  fn: string;
  args: Record<string, unknown>;
}

const mockState = vi.hoisted(() => {
  const calls: ApiCall[] = [];
  let sendMessageFail = false;
  let presignFail = false;
  let putFail = false;
  let imageSendMode: "ok" | "throw" | "noid" = "ok";
  return {
    calls,
    get sendMessageFail() { return sendMessageFail; },
    set sendMessageFail(v: boolean) { sendMessageFail = v; },
    get presignFail() { return presignFail; },
    set presignFail(v: boolean) { presignFail = v; },
    get putFail() { return putFail; },
    set putFail(v: boolean) { putFail = v; },
    get imageSendMode() { return imageSendMode; },
    set imageSendMode(v: "ok" | "throw" | "noid") { imageSendMode = v; },
    reset() {
      calls.length = 0;
      sendMessageFail = false;
      presignFail = false;
      putFail = false;
      imageSendMode = "ok";
    },
  };
});

// Fake secrets embedded in mock errors/URLs — the redaction test asserts they
// never surface in DeliveryReport parts or console output.
vi.mock("../octo/api.js", () => ({
  sendTyping: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "sendTyping", args: params });
  }),
  sendMessage: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "sendMessage", args: params });
    if (mockState.sendMessageFail) throw new Error("sendMessage failed");
    // Canonical int64-shaped id so lifecycle tests reach the confirmed path.
    return { message_id: "9001", client_msg_no: "c1", message_seq: 1 };
  }),
  getUploadPresign: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "getUploadPresign", args: params });
    if (mockState.presignFail) {
      // Simulated leak source: exception text carrying a signed URL + credentials.
      throw new Error("presign refused: https://storage.test/u?X-Amz-Signature=SIGSECRET123&x-session-token=TOKENSECRET456 tmpSecretKey=KEYSECRET789");
    }
    return {
      uploadUrl: `https://storage.test/upload/${String(params.filename)}?X-Amz-Signature=SIGSECRET123&x-session-token=TOKENSECRET456`,
      downloadUrl: `https://cdn.test/media/${String(params.filename)}`,
      contentType: params.contentType ?? "application/octet-stream",
    };
  }),
  uploadFileToPresignedUrl: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "uploadFileToPresignedUrl", args: params });
    if (mockState.putFail) {
      throw new Error(`PUT rejected: ${String(params.uploadUrl)} tmpSecretKey=KEYSECRET789`);
    }
    return { url: params.downloadUrl };
  }),
  sendImageMessage: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "sendImageMessage", args: params });
    if (mockState.imageSendMode === "throw") {
      throw new Error("send lost after upload to https://cdn.test/x?sig=SIGSECRET123 sessionToken=TOKENSECRET456 tmpSecretKey=KEYSECRET789");
    }
    if (mockState.imageSendMode === "noid") {
      return { message_id: "not-canonical", client_msg_no: "c", message_seq: 1 };
    }
    return { message_id: "9001", client_msg_no: params.clientMsgNo, message_seq: 1 };
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

async function* asyncChunks(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

// Import after mock setup so vi.mock hoisting takes effect.
const { StreamRelay } = await import("../stream-relay.js");

describe("StreamRelay", () => {
  let relay: StreamRelay;
  it('redacts SDK rejected records through the real delivery boundary and rethrows', async () => {
    const failure = new Error('Failed to parse item: SYNTHETIC_PRIVATE_OUTPUT token=synthetic-key', { cause: new SyntaxError('Unterminated string') });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    async function* broken() { yield 'safe partial'; throw failure; }
    try {
      const result = relay.deliver(CH_ID, CH_TYPE, broken(), API_URL, BOT_TOKEN);
      const assertion = expect(result).rejects.toBe(failure);
      await vi.runAllTimersAsync();
      await assertion;
      expect(JSON.stringify(logs.mock.calls)).toContain('incomplete-json');
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/SYNTHETIC_PRIVATE_OUTPUT|synthetic-key/);
    } finally { logs.mockRestore(); }
  });

  const CH_ID = "test_channel";
  const CH_TYPE = 2; // Group
  const API_URL = "https://api.test";
  const BOT_TOKEN = "***";

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.reset();
    relay = new StreamRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers text via sendMessage", async () => {
    const chunks = asyncChunks(["Hello, world!"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect((sendCalls[0].args as { content: string }).content).toBe("Hello, world!");
  });

  it("sends typing indicator at the start", async () => {
    const chunks = asyncChunks(["Hi"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const typingCalls = mockState.calls.filter((c) => c.fn === "sendTyping");
    expect(typingCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("splits long text into segments", async () => {
    const longText = "word ".repeat(1500); // ~7500 chars
    const chunks = asyncChunks([longText]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    const reassembled = sendCalls.map((c) => (c.args as { content: string }).content).join("");
    expect(reassembled).toBe(longText);
  });

  it("handles empty stream (no output)", async () => {
    const chunks = asyncChunks([]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const nonTyping = mockState.calls.filter((c) => c.fn !== "sendTyping");
    expect(nonTyping.length).toBe(0);
  });

  it("cleans up typing timer on completion", async () => {
    const chunks = asyncChunks(["done"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("cleans up typing timer on error", async () => {
    mockState.sendMessageFail = true;

    const chunks = asyncChunks(["fail"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    const guarded = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await guarded;

    // Q23: sendMessage failures are swallowed per-segment; deliver() should not reject.
    await expect(promise).resolves.toEqual({parts:[]});

    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("accumulates multiple chunks before sending", async () => {
    const chunks = asyncChunks(["Hello", ", ", "world", "!"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect((sendCalls[0].args as { content: string }).content).toBe("Hello, world!");
  });

  it("passes correct channelId and channelType to all calls", async () => {
    const chunks = asyncChunks(["test"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    for (const call of mockState.calls) {
      expect(call.args.channelId).toBe(CH_ID);
      expect(call.args.channelType).toBe(CH_TYPE);
    }
  });

  it("flushes partial output and re-throws when the source iterable throws mid-stream", async () => {
    async function* throwingChunks(): AsyncIterable<string> {
      yield "partial";
      throw new Error("source exploded");
    }

    const chunks = throwingChunks();
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    const guarded = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await guarded;

    // The error still propagates so the caller's error path runs…
    await expect(promise).rejects.toThrow("source exploded");

    // …but the partial output accumulated before the throw is NOT dropped — it is
    // flushed to the channel (PR review: previously a real partial reply was lost).
    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].args.content).toBe("partial");

    // Typing timer should be cleaned up.
    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("passes apiUrl and botToken to sendMessage", async () => {
    const chunks = asyncChunks(["test content"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].args.apiUrl).toBe(API_URL);
    expect(sendCalls[0].args.botToken).toBe(BOT_TOKEN);
  });

  it("continues sending remaining segments when one fails", async () => {
    let callCount = 0;
    const { sendMessage } = await import("../octo/api.js");
    (sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (params: Record<string, unknown>) => {
      mockState.calls.push({ fn: "sendMessage", args: params });
      callCount++;
      if (callCount === 2) throw new Error("transient failure");
      return { message_id: "msg_1", client_msg_no: "c1", message_seq: 1 };
    });

    const longText = "word ".repeat(1500); // ~7500 chars → 3 segments
    const chunks = asyncChunks([longText]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise; // Should NOT throw

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(3); // All 3 segments attempted
  });

  // ── G7: @mention resolution in deliver() ─────────────────────────────────

  it("resolves @[uid:name] structured mentions and includes mentionUids/Entities", async () => {
    const chunks = asyncChunks(["hello @[u1:Alice] and @[u2:Bob]"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    const args = sendCalls[0].args as {
      content: string;
      mentionUids?: string[];
      mentionEntities?: Array<{ uid: string; offset: number; length: number }>;
    };
    expect(args.content).toBe("hello @Alice and @Bob");
    expect(args.mentionUids).toEqual(["u1", "u2"]);
    expect(args.mentionEntities).toHaveLength(2);
  });

  it("resolves plain @name via memberMap", async () => {
    const memberMap = new Map([["Alice", "u1"], ["Bob", "u2"]]);
    const chunks = asyncChunks(["hi @Alice and @Bob"]);
    const promise = relay.deliver(
      CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN, undefined, memberMap,
    );
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    const args = sendCalls[0].args as { mentionUids?: string[] };
    expect(args.mentionUids).toEqual(["u1", "u2"]);
  });

  it("detects @all and sets mentionAll flag", async () => {
    const chunks = asyncChunks(["@all please review"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    const args = sendCalls[0].args as { mentionAll?: boolean };
    expect(args.mentionAll).toBe(true);
  });

  it("omits mention fields when no mentions present", async () => {
    const chunks = asyncChunks(["just plain text"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    const args = sendCalls[0].args as Record<string, unknown>;
    expect(args.mentionUids).toBeUndefined();
    expect(args.mentionEntities).toBeUndefined();
    expect(args.mentionAll).toBeUndefined();
  });

  // ─── C2 P0-1: splitMessage must not break @[uid:name] across segments ─────
  //
  // Repro: text where the LAST space within the first maxChars chunk falls
  // INSIDE the displayName of an @[uid:John Smith Junior] mention. The space-
  // priority split would cut at "John " — leaving seg0 = "...@[uid:John " and
  // seg1 = "Smith Junior]..." — both unparseable, user sees raw text in chat
  // and never receives the @-notification.
  //
  // Fix verifies: resolve mentions globally first, THEN splitMessage on the
  // already-resolved @name text. @[uid:John Smith Junior] becomes
  // @John Smith Junior before split, so split can never cut inside `[...]`.
  it("P0-1: splitMessage cannot break structured @[uid:name] across segments", async () => {
    // Build text where without the fix, the space inside `John Smith Junior`
    // would be the LAST space within the first 3500 chars and splitMessage
    // would cut there.
    const prefix = "a".repeat(3490);
    const mention = "@[uid_x:John Smith Junior]";
    const trailing = "continuestextwithoutspacelongenoughtopastthehardlimit" + "x".repeat(150);
    const text = prefix + mention + " " + trailing;

    const chunks = asyncChunks([text]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    // No segment may contain a broken structured mention:
    for (const call of sendCalls) {
      const args = call.args as { content: string };
      expect(args.content).not.toContain("@[uid_x:");
      expect(args.content).not.toMatch(/Smith Junior\][^@]/);
    }

    // At least one segment must carry the resolved @John Smith Junior
    // + correctly mapped entity.
    const carryingCall = sendCalls.find(c => {
      const args = c.args as { content: string; mentionUids?: string[] };
      return args.content.includes("@John Smith Junior")
        && (args.mentionUids ?? []).includes("uid_x");
    });
    expect(carryingCall).toBeDefined();

    const args = carryingCall!.args as {
      content: string;
      mentionEntities?: Array<{ uid: string; offset: number; length: number }>;
    };
    const ent = (args.mentionEntities ?? []).find(e => e.uid === "uid_x");
    expect(ent).toBeDefined();
    // Entity offset is segment-local and points to the @ in this segment.
    expect(args.content.slice(ent!.offset, ent!.offset + ent!.length))
      .toBe("@John Smith Junior");
  });

  it("P0-1: mentionAll applied to first segment only (no notification spam)", async () => {
    // Force a multi-segment send with @all in the prefix. mentionAll must
    // fire on exactly one segment (the first) to avoid spamming @所有人
    // notifications when a reply is long enough to span chunks.
    const text = "@all please review:\n\n" + "x".repeat(3490) + "\n\n" + "y".repeat(500);
    const chunks = asyncChunks([text]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThan(1);
    const mentionAllFlags = sendCalls.map(
      c => (c.args as { mentionAll?: boolean }).mentionAll === true,
    );
    const trueCount = mentionAllFlags.filter(x => x).length;
    expect(trueCount).toBe(1);
    expect(mentionAllFlags[0]).toBe(true);
  });

  // ─── C2 P1-6: truncation must not split a surrogate pair ──────────────
  it("P1-6: truncation does not split surrogate pair", async () => {
    // emoji 😀 = high+low surrogate (2 code units). Position the high
    // surrogate exactly at index (N-1) so unguarded slice(0, N) would leave
    // an orphan high surrogate.
    const N = 100;
    const filler = "a".repeat(N - 1);
    const emoji = "\uD83D\uDE00";
    const text = filler + emoji + "more text afterwards";

    const chunks = asyncChunks([text]);
    const promise = relay.deliver(
      CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN, N,
    );
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThan(0);
    const combined = sendCalls
      .map(c => (c.args as { content: string }).content)
      .join("");
    // Verify no orphan high surrogate anywhere in sent content.
    for (let i = 0; i < combined.length; i++) {
      const code = combined.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = combined.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
      }
    }
  });

  // ─── #95: outbound image delivery ─────────────────────────────────────────

  function makeImage(name: string, width?: number, height?: number): PreparedImage {
    return {
      name,
      size: 1234,
      contentType: "image/png",
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      body: Buffer.from(`bytes-of-${name}`),
    };
  }

  function imageCalls(fn: string): ApiCall[] {
    return mockState.calls.filter((c) => c.fn === fn);
  }

  it("case 4: delivers [text1, text2, image1, image2] in order with exact payloads", async () => {
    // An earlier test permanently overrides the shared sendMessage mock with a
    // non-canonical message_id ("msg_1"); lifecycle delivery requires canonical
    // ids, so restore a deterministic implementation for this test.
    const { sendMessage } = await import("../octo/api.js");
    (sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (params: Record<string, unknown>) => {
      mockState.calls.push({ fn: "sendMessage", args: params });
      return { message_id: "9001", client_msg_no: "c1", message_seq: 1 };
    });

    const turn = new TurnContext(0);
    const store = { saveDeliveryParts: vi.fn(), markDeliveryPart: vi.fn() };
    const text = "a".repeat(2000) + "\n\n" + "b".repeat(2000); // → 2 segments
    const img1 = makeImage("one.png", 11, 22);
    const img2 = makeImage("two.png", 33, 44);

    const promise = relay.deliver(
      CH_ID, CH_TYPE, asyncChunks([text]), API_URL, BOT_TOKEN,
      undefined, undefined, undefined,
      { turn, store: store as never },
      [img1, img2],
    );
    await vi.runAllTimersAsync();
    const report = await promise;

    // Order: every text segment first, then images in array order.
    const order = mockState.calls
      .filter((c) => c.fn === "sendMessage" || c.fn === "sendImageMessage")
      .map((c) => c.fn);
    expect(order).toEqual(["sendMessage", "sendMessage", "sendImageMessage", "sendImageMessage"]);

    const textCalls = imageCalls("sendMessage");
    expect((textCalls[0].args as { content: string }).content).toBe("a".repeat(2000) + "\n\n");
    expect((textCalls[1].args as { content: string }).content).toBe("b".repeat(2000));

    // Image payload metadata must match the prepared upload products exactly.
    const sends = imageCalls("sendImageMessage");
    expect(sends[0].args).toMatchObject({
      channelId: CH_ID, channelType: CH_TYPE,
      url: "https://cdn.test/media/one.png", name: "one.png", size: 1234, width: 11, height: 22,
    });
    expect(sends[1].args).toMatchObject({
      url: "https://cdn.test/media/two.png", name: "two.png", size: 1234, width: 33, height: 44,
    });

    // presign gets the exact byte count + sniffed type; PUT replays the signed
    // contentType and the very same body buffer.
    const presigns = imageCalls("getUploadPresign");
    expect(presigns[0].args).toMatchObject({ filename: "one.png", fileSize: 1234, contentType: "image/png" });
    const puts = imageCalls("uploadFileToPresignedUrl");
    expect((puts[0].args as { contentType: string }).contentType).toBe("image/png");
    expect((puts[0].args as { fileBody: Buffer }).fileBody.equals(img1.body)).toBe(true);

    // Report: 2 text parts + 2 sent image parts.
    expect(report.parts).toHaveLength(4);
    expect(report.parts[2]).toMatchObject({ kind: "image", state: "sent", stage: "send", name: "one.png", messageId: "9001" });
    expect(report.parts[3]).toMatchObject({ kind: "image", state: "sent", name: "two.png" });

    // Durable ledger: ONE save with 4 contiguous entries; image payloads carry
    // name/size/contentType only — never local paths, bodies or presigned URLs.
    expect(store.saveDeliveryParts).toHaveBeenCalledTimes(1);
    const saved = (store.saveDeliveryParts.mock.calls[0] as unknown as [string, Array<{ clientMsgNo: string; payload: string }>])[1];
    expect(saved).toHaveLength(4);
    const imgPayload = JSON.parse(saved[2].payload) as Record<string, unknown>;
    expect(imgPayload).toMatchObject({ kind: "image", name: "one.png", size: 1234, contentType: "image/png" });
    expect("path" in imgPayload).toBe(false);
    expect("body" in imgPayload).toBe(false);
    expect(saved[2].payload).not.toContain("storage.test");
    expect(store.markDeliveryPart).toHaveBeenCalledWith(turn.turnId, 2, "confirmed", "9001");
    expect(store.markDeliveryPart).toHaveBeenCalledWith(turn.turnId, 3, "confirmed", "9001");
  });

  it("case 9: PUT failure → unknown with put stage tag; generation is never re-run", async () => {
    mockState.putFail = true;
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The "generation" already happened exactly once per image before delivery.
      const generateImage = vi.fn((name: string) => makeImage(name));
      const images = [generateImage("gen1.png"), generateImage("gen2.png")];

      const promise = relay.deliver(
        CH_ID, CH_TYPE, asyncChunks([]), API_URL, BOT_TOKEN,
        undefined, undefined, undefined, undefined, images,
      );
      await vi.runAllTimersAsync();
      const report = await promise; // must NOT reject — text-less, image-failed turn still reports

      const imgParts = report.parts.filter((p): p is ImageDeliveryPart => "kind" in p && p.kind === "image");
      expect(imgParts).toHaveLength(2);
      for (const part of imgParts) {
        expect(part.state).toBe("unknown"); // delivery outcome unproven — never "failed", never "sent"
        expect(part.stage).toBe("put");
        expect(part.error).toContain("put"); // stage-locatable error tag
      }
      // A delivery failure NEVER re-triggers image generation…
      expect(generateImage).toHaveBeenCalledTimes(2);
      // …and both images are attempted (partial success), none sent.
      expect(imageCalls("uploadFileToPresignedUrl")).toHaveLength(2);
      expect(imageCalls("sendImageMessage")).toHaveLength(0);
    } finally {
      logs.mockRestore();
    }
  });

  it("case 10: send response lost → unknown, never resent; garbage ack id → unknown", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Network error on the image sendMessage: exactly ONE call, state unknown.
      mockState.imageSendMode = "throw";
      let promise = relay.deliver(
        CH_ID, CH_TYPE, asyncChunks([]), API_URL, BOT_TOKEN,
        undefined, undefined, undefined, undefined, [makeImage("lost.png")],
      );
      await vi.runAllTimersAsync();
      let report = await promise;
      let part = report.parts.find((p): p is ImageDeliveryPart => "kind" in p && p.kind === "image");
      expect(part).toMatchObject({ state: "unknown", stage: "send", name: "lost.png" });
      expect(imageCalls("sendImageMessage")).toHaveLength(1); // no resend

      // Response arrives but the ack carries no canonical message_id → unknown, no resend.
      mockState.reset();
      mockState.imageSendMode = "noid";
      promise = relay.deliver(
        CH_ID, CH_TYPE, asyncChunks([]), API_URL, BOT_TOKEN,
        undefined, undefined, undefined, undefined, [makeImage("noid.png")],
      );
      await vi.runAllTimersAsync();
      report = await promise;
      part = report.parts.find((p): p is ImageDeliveryPart => "kind" in p && p.kind === "image");
      expect(part).toMatchObject({ state: "unknown", stage: "send", name: "noid.png" });
      expect(part!.messageId).toBeUndefined();
      expect(imageCalls("sendImageMessage")).toHaveLength(1); // no resend
    } finally {
      logs.mockRestore();
    }
  });

  it("case 11: signatures/sessionToken/tmpSecretKey never leak via parts or console", async () => {
    const secrets = ["SIGSECRET123", "TOKENSECRET456", "KEYSECRET789"];
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const mode of ["presign", "put", "send"] as const) {
        mockState.reset();
        mockState.presignFail = mode === "presign";
        mockState.putFail = mode === "put";
        mockState.imageSendMode = mode === "send" ? "throw" : "ok";

        const promise = relay.deliver(
          CH_ID, CH_TYPE, asyncChunks(["text body"]), API_URL, BOT_TOKEN,
          undefined, undefined, undefined, undefined, [makeImage("leak.png")],
        );
        await vi.runAllTimersAsync();
        const report = await promise;

        const dumped = JSON.stringify(report.parts)
          + JSON.stringify(logs.mock.calls)
          + JSON.stringify(warns.mock.calls);
        for (const secret of secrets) {
          expect(dumped, `secret ${secret} leaked in ${mode} mode`).not.toContain(secret);
        }
        const part = report.parts.find((p): p is ImageDeliveryPart => "kind" in p && p.kind === "image");
        expect(part).toBeDefined();
        expect(part!.state).toBe("unknown");
        expect(part!.error).toBe(`${mode}:error`); // fixed tag, no raw exception text
      }
    } finally {
      logs.mockRestore();
      warns.mockRestore();
    }
  });

  it("case 12: abort before image delivery → AbortError, zero image API calls", async () => {
    const turn = new TurnContext(0);
    const store = { saveDeliveryParts: vi.fn(), markDeliveryPart: vi.fn() };
    turn.cancel(); // revoked before deliver starts — images must never be touched

    const promise = relay.deliver(
      CH_ID, CH_TYPE, asyncChunks([]), API_URL, BOT_TOKEN,
      undefined, undefined, undefined,
      { turn, store: store as never },
      [makeImage("cancelled.png")],
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(imageCalls("getUploadPresign")).toHaveLength(0);
    expect(imageCalls("uploadFileToPresignedUrl")).toHaveLength(0);
    expect(imageCalls("sendImageMessage")).toHaveLength(0);
  });
});
