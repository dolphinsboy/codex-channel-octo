import { randomUUID } from 'node:crypto';
import { AgentFailure } from './agent-failure.js';
import type { TurnContext } from './turn-context.js';
import type { SessionStore } from './session-store.js';
/**
 * Stream Relay — typing heartbeat + message splitting + plain sendMessage delivery.
 *
 * Consumes an AsyncIterable<string> of text chunks and delivers them to Octo
 * via plain sendMessage with intelligent splitting.
 *
 * Design constraints:
 * - Knows nothing about the agent SDK — input is a generic async text stream.
 * - All Octo API calls go through the api.ts functions (no raw fetch).
 * - Typing indicators keep the user informed while chunks accumulate.
 */

import type { ChannelType } from "./octo/types.js";
import {
  sendTyping,
  sendMessage,
  sendImageMessage,
  getUploadPresign,
  uploadFileToPresignedUrl,
} from "./octo/api.js";
import type { OutboundImageStage, PreparedImage } from "./media-outbound.js";
import { resolveMentions } from "./mention-utils.js";
import { TRUNCATION_SUFFIX, DEFAULT_MAX_RESPONSE_CHARS } from "./output-selection.js";
import { summarizeAgentError } from "./agent-errors.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Interval (ms) between typing indicator pings. */
const TYPING_INTERVAL_MS = 5_000;

/** Maximum characters per message segment. */
const MAX_SEGMENT_CHARS = 3_500;

// ─── Message Splitting ─────────────────────────────────────────────────────

/** A protected range that splitMessage must not cut through. */
export interface ProtectedRange {
  /** Start offset (inclusive, UTF-16 code units). */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

/**
 * Adjust a candidate split position so it does not fall strictly inside any
 * protected range. If splitAt lands inside [start, end), prefer pushing back
 * to `start` (move the protected unit whole to the next segment).
 *
 * Returns the adjusted split position, or null if pulling back would land at 0.
 */
function adjustSplitForProtectedRanges(
  splitAt: number,
  protectedRanges: ProtectedRange[],
): number | null {
  for (const range of protectedRanges) {
    if (splitAt > range.start && splitAt < range.end) {
      // Pull BACK to range.start so the protected unit moves whole to next seg.
      if (range.start > 0) return range.start;
      // Range starts at 0 — can't pull back. Caller will deal.
      return null;
    }
  }
  return splitAt;
}

/**
 * Split a long text into segments at natural boundaries.
 *
 * Priority: paragraph break (\n\n) > newline (\n) > space > hard cut.
 * Each segment is at most `maxChars` characters.
 *
 * `protectedRanges` (P0-1): byte ranges that must NOT be split through. Used
 * by deliver() to keep resolved @name mentions intact — a name like
 * "@John Smith Junior" must be sent as one unit so the corresponding
 * MentionEntity offset/length lands cleanly in one segment.
 */
export function splitMessage(
  text: string,
  maxChars: number = MAX_SEGMENT_CHARS,
  protectedRanges: ProtectedRange[] = [],
): string[] {
  if (maxChars < 1) {
    throw new Error(`splitMessage: maxChars must be >= 1, got ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];

  const segments: string[] = [];
  let remaining = text;
  let consumed = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      segments.push(remaining);
      break;
    }

    const chunk = remaining.slice(0, maxChars);
    // Translate global ranges to local offsets relative to remaining.
    const localRanges = protectedRanges
      .filter(r => r.end > consumed && r.start < consumed + remaining.length)
      .map(r => ({ start: r.start - consumed, end: r.end - consumed }));

    let splitAt = -1;
    function tryCandidate(candidate: number): boolean {
      const adj = adjustSplitForProtectedRanges(candidate, localRanges);
      if (adj === null || adj <= 0 || adj > maxChars) return false;
      splitAt = adj;
      return true;
    }

    // 1. Paragraph break (\n\n) — prefer the last one within range.
    const paraIdx = chunk.lastIndexOf("\n\n");
    if (paraIdx > 0) tryCandidate(paraIdx + 2);

    // 2. Newline (\n)
    if (splitAt === -1) {
      const nlIdx = chunk.lastIndexOf("\n");
      if (nlIdx > 0) tryCandidate(nlIdx + 1);
    }

    // 3. Space
    if (splitAt === -1) {
      const spIdx = chunk.lastIndexOf(" ");
      if (spIdx > 0) tryCandidate(spIdx + 1);
    }

    // 4. Hard cut — avoid splitting surrogate pairs AND protected ranges.
    if (splitAt === -1) {
      splitAt = maxChars;
      // If the cut falls between a surrogate pair, back up one code unit.
      const code = remaining.charCodeAt(splitAt - 1);
      if (code >= 0xD800 && code <= 0xDBFF) splitAt--;
      // If the cut falls inside a protected range, pull back to its start.
      // Pathological case (range starts at 0 and exceeds maxChars): we fall
      // back to maxChars and accept the broken mention rather than infinite
      // loop. In practice an @[uid:name] is far shorter than maxChars=3500.
      const adj = adjustSplitForProtectedRanges(splitAt, localRanges);
      if (adj !== null && adj > 0) splitAt = Math.min(adj, maxChars);
    }

    segments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    consumed += splitAt;
  }

  return segments;
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

export interface DeliveryPart { clientMsgNo: string; state: 'confirmed' | 'unknown'; messageId?: string; }
/**
 * #95 image part. state mirrors the outbound image state machine:
 * 'sent' = server confirmed a canonical message_id; 'unknown' = presign/put/send
 * failed or the ack carried no valid id (delivery outcome unproven — NEVER
 * resent, the bot endpoint has no idempotency contract); 'failed' is reserved
 * for pre-delivery (validate) rejections recorded by the caller.
 */
export interface ImageDeliveryPart { kind: 'image'; clientMsgNo: string; name: string; state: 'sent' | 'failed' | 'unknown'; stage: OutboundImageStage; messageId?: string; error?: string; }
export interface DeliveryReport { parts: Array<DeliveryPart | ImageDeliveryPart>; }
/** Sanitized per-part error tag: stage + fixed category, never raw exception text (may carry the signed URL/credentials). */
function imagePartError(stage: OutboundImageStage, error: unknown): string {
  return error instanceof AgentFailure ? `${stage}:${error.snapshot.category}` : `${stage}:error`;
}
function confirmedMessageId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  // parseOctoJson preserves large numeric tokens as strings, including malformed
  // leading-zero tokens. Only canonical positive decimal int64 identities may
  // authorize durable confirmation. Bound length before converting to BigInt.
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : undefined;
}
export class StreamRelay {
  /**
   * Deliver an async stream of text chunks to an Octo channel.
   *
   * 1. Starts a typing indicator heartbeat (5 s interval).
   * 2. Accumulates all chunks from the async iterable.
   * 3. Sends the accumulated text via plain sendMessage with splitting.
   * 4. #95: sends prepared images (presign → PUT → Image message) AFTER all
   *    text segments, in array order. `images` is read only after the stream
   *    is fully drained — callers may fill the array from inside the iterable.
   * 5. Always cleans up the typing heartbeat.
   */
  async deliver(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
    maxResponseChars: number = DEFAULT_MAX_RESPONSE_CHARS,
    memberMap?: Map<string, string>,
    isValidUid?: (uid: string) => boolean,
    lifecycle?: { turn: TurnContext; store: SessionStore },
    images?: PreparedImage[],
  ): Promise<DeliveryReport> {
    const report: DeliveryReport = { parts: [] };
    const check = () => lifecycle?.turn.assertPublishable();
    check();
    // --- Typing heartbeat ---
    const typingParams = { apiUrl, botToken, channelId, channelType, ...(lifecycle ? { signal: lifecycle.turn.signal } : {}) };
    // Fire one immediately — don't wait for the first interval tick.
    sendTyping(typingParams).catch(() => {});
    const typingTimer = setInterval(() => {
      if (!lifecycle?.turn.signal.aborted) sendTyping(typingParams).catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      // Accumulate all chunks, with truncation guard (Q32).
      let accumulated = "";
      let truncated = false;
      // If the agent stream throws mid-way (network blip, non-recoverable SDK
      // error after partial output), we still want to deliver what we have
      // instead of dropping a real partial reply on the floor — then re-throw so
      // the caller's error path still runs. Capture the error and flush below.
      let streamError: unknown;
      try {
        for await (const chunk of chunks) {
          check();
          accumulated += chunk;
          // Q32: Stop accumulating once limit is reached to prevent unbounded memory.
          if (accumulated.length > maxResponseChars) {
            // P1-6: cut at code-unit boundary, but back off if it lands inside
            // a surrogate pair (would produce an orphan high surrogate = invalid
            // Unicode). Mirrors splitMessage's hard-cut surrogate guard.
            let cutAt = maxResponseChars;
            const code = accumulated.charCodeAt(cutAt - 1);
            if (code >= 0xD800 && code <= 0xDBFF) cutAt--;
            accumulated = accumulated.slice(0, cutAt) + TRUNCATION_SUFFIX;
            truncated = true;
            break;
          }
        }
      } catch (err) {
        streamError = err;
        console.error(`[stream-relay] agent stream threw after ${accumulated.length} char(s); flushing partial output: ${summarizeAgentError(err)}`);
      }
      if (truncated) {
        console.warn(`[stream-relay] Response truncated at ${maxResponseChars} chars`);
      }

      // Send accumulated text via plain messages with splitting.
      const pending: Array<Parameters<typeof sendMessage>[0]> = [];
      if (accumulated.length > 0) {
        // P0-1: Resolve @[uid:name] structured mentions and @name ONCE on the
        // full accumulated text, BEFORE splitting. This guarantees splitMessage
        // cannot break a structured mention across segments — by the time
        // splitMessage runs, @[uid:name] is already @name. We additionally
        // pass each resolved @name as a ProtectedRange so splitMessage avoids
        // cutting through names that contain spaces (e.g. "John Smith").
        const {
          finalContent,
          mentionEntities: globalEntities,
          mentionAll,
        } = resolveMentions(accumulated, memberMap, isValidUid);

        const protectedRanges = globalEntities.map(e => ({
          start: e.offset,
          end: e.offset + e.length,
        }));

        const segments = splitMessage(finalContent, undefined, protectedRanges);
        let segStart = 0;
        let mentionAllConsumed = false;
        for (const segment of segments) {
          const segEnd = segStart + segment.length;
          // Partition entities falling within this segment, re-rebase to
          // segment-local offsets. Server expects per-message offsets.
          const segEntities = globalEntities
            .filter(e => e.offset >= segStart && e.offset + e.length <= segEnd)
            .map(e => ({ uid: e.uid, offset: e.offset - segStart, length: e.length }));
          const segUids = segEntities.map(e => e.uid);

          // mentionAll only applies to one segment (the first). Avoids spamming
          // @所有人 notifications when a reply spans multiple chunks.
          //
          // Design choice (王大锤 PR#45 review note): we attach mentionAll to the
          // FIRST segment unconditionally, not to the segment that actually
          // contains the resolved "@all"/"@所有人" text. Three reasons:
          //   1. mentionAll on the Octo API is a wire-level notification flag,
          //      independent of where the literal "@all" text appears.
          //   2. The first segment is always sent first — attaching the flag
          //      there minimizes notification latency.
          //   3. The literal text may have been resolved/rewritten by the LLM
          //      into multiple positions; pinning to segment 0 is unambiguous.
          // Alternative considered: scan each segment for @all literal and
          // attach the flag only to segments containing it. Rejected because
          // it would double-notify when @all appears more than once.
          const useMentionAll = mentionAll && !mentionAllConsumed;
          if (useMentionAll) mentionAllConsumed = true;

          pending.push({ apiUrl, botToken, channelId, channelType, content: segment,
            clientMsgNo: randomUUID(),
            ...(segUids.length > 0 ? { mentionUids: segUids } : {}),
            ...(segEntities.length > 0 ? { mentionEntities: segEntities } : {}),
            ...(useMentionAll ? { mentionAll: true } : {}),
            ...(lifecycle ? { signal: lifecycle.turn.signal } : {}),
          });
          segStart = segEnd;
        }
      }
      // #95: prepared images ride the same durable ledger as text parts, with
      // contiguous part_index. Read ONLY after the stream is fully drained —
      // index.ts fills the array from inside the iterable. Payloads carry
      // name/size/contentType only: never local paths, file bodies or URLs.
      const imageParts = (images ?? []).map(image => ({ clientMsgNo: randomUUID(), image }));
      // Persist fixed payloads/keys before the first external send. Never persist the token.
      if (pending.length > 0 || imageParts.length > 0) {
        check();
        try { lifecycle?.store.saveDeliveryParts(lifecycle.turn.turnId, [
          ...pending.map(part => ({ clientMsgNo: part.clientMsgNo!, payload: JSON.stringify({
            channelId, channelType, content: part.content, mentionUids: part.mentionUids,
            mentionEntities: part.mentionEntities, mentionAll: part.mentionAll,
          }) })),
          ...imageParts.map(entry => ({ clientMsgNo: entry.clientMsgNo, payload: JSON.stringify({
            kind: 'image', channelId, channelType,
            name: entry.image.name, size: entry.image.size, contentType: entry.image.contentType,
          }) })),
        ]);
        } catch { throw new AgentFailure({ stage: 'history_commit', category: 'history_failed', source: 'local', evidence: 'structured' }); }
      }
      for (const [index, part] of pending.entries()) {
        check();
        try {
          lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, index, 'unknown');
          const result = await sendMessage(part);
          check();
          // The send endpoint can return a server-generated client_msg_no.
          // Correlate this acknowledgement through the awaited HTTP request;
          // the returned key need not echo our local correlation key. The bot
          // endpoint does not establish idempotency from this request field.
          const id = confirmedMessageId(result?.message_id);
          const state = id ? 'confirmed' : 'unknown';
          lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, index, state, id);
          report.parts.push({ clientMsgNo: part.clientMsgNo!, state, ...(id ? { messageId: id } : {}) });
          if (!id && lifecycle) throw new AgentFailure({ stage: 'delivery', category: 'delivery_failed', source: 'octo_api', evidence: 'structured' });
        } catch (error) {
          if (lifecycle?.turn.signal.aborted) throw error;
          lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, index, 'unknown');
          if (lifecycle) throw error instanceof AgentFailure ? error : new AgentFailure({ stage: 'delivery', category: 'delivery_failed', source: 'octo_api', evidence: 'structured' });
          console.error(`[stream-relay] delivery failed: ${summarizeAgentError(error)}`);
        }
      }
      // Delivery uncertainty stops later segments; it must not trigger model replay.
      // If accumulated is empty, the agent produced no output — nothing to send.
      // If the stream threw mid-way, we've now flushed whatever partial text was
      // accumulated; re-throw so the caller's error handling still runs (it will
      // not double-send — the partial was delivered here, the caller only logs /
      // surfaces the failure). Image delivery is skipped on a failed stream.
      if (streamError !== undefined) throw streamError;
      // #95: all text segments are out; deliver images one by one in instruction
      // order (README ordering contract). Any presign/put/send failure or a
      // missing valid message_id leaves the part 'unknown' — never resent (no
      // server-side idempotency contract). Local validate rejections are
      // recorded by the caller and never reach this loop.
      for (const [offset, entry] of imageParts.entries()) {
        const index = pending.length + offset;
        const { clientMsgNo, image } = entry;
        let stage: OutboundImageStage = 'presign';
        try {
          check();
          lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, index, 'unknown');
          const presign = await getUploadPresign({
            apiUrl, botToken, filename: image.name, fileSize: image.size, contentType: image.contentType,
            ...(lifecycle ? { signal: lifecycle.turn.signal } : {}),
          });
          stage = 'put';
          const uploaded = await uploadFileToPresignedUrl({
            uploadUrl: presign.uploadUrl, downloadUrl: presign.downloadUrl,
            fileBody: image.body, fileSize: image.size,
            // Replay the signed headers VERBATIM — any deviation is a 403 (SigV4 canonical headers).
            contentType: presign.contentType,
            ...(presign.contentDisposition !== undefined ? { contentDisposition: presign.contentDisposition } : {}),
            ...(lifecycle ? { signal: lifecycle.turn.signal } : {}),
          });
          stage = 'send';
          check();
          const result = await sendImageMessage({
            apiUrl, botToken, channelId, channelType, url: uploaded.url,
            name: image.name, size: image.size,
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {}),
            ...(image.caption !== undefined ? { caption: image.caption } : {}),
            clientMsgNo,
            ...(lifecycle ? { signal: lifecycle.turn.signal } : {}),
          });
          check();
          const id = confirmedMessageId(result?.message_id);
          if (id) {
            lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, index, 'confirmed', id);
            report.parts.push({ kind: 'image', clientMsgNo, name: image.name, state: 'sent', stage, messageId: id });
          } else {
            report.parts.push({ kind: 'image', clientMsgNo, name: image.name, state: 'unknown', stage });
          }
        } catch (error) {
          if (lifecycle?.turn.signal.aborted) {
            // Cancelled: best-effort mark this and the remaining images unknown
            // (the guarded store may refuse writes), then propagate the AbortError.
            for (let rest = offset; rest < imageParts.length; rest++) {
              try { lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, pending.length + rest, 'unknown'); } catch { /* ownership already revoked */ }
            }
            throw error;
          }
          lifecycle?.store.markDeliveryPart(lifecycle.turn.turnId, index, 'unknown');
          report.parts.push({ kind: 'image', clientMsgNo, name: image.name, state: 'unknown', stage, error: imagePartError(stage, error) });
          console.error(`[stream-relay] image delivery failed at ${stage}: ${summarizeAgentError(error)}`);
          // No rethrow: the text is already out; one failed image must not fail the
          // turn — continue with the remaining images (per-item partial success).
        }
      }
      return report;
    } finally {
      clearInterval(typingTimer);
    }
  }
}
