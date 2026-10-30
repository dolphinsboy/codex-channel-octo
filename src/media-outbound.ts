/**
 * Outbound image delivery (issue #95).
 *
 * Symmetric to media-inbound.ts: inbound downloads conversation images INTO the
 * session cwd sandbox so the model can see them; outbound uploads model-generated
 * local images back to Octo as native Image(type=2) messages.
 *
 * Protocol: the agent explicitly emits an `octo-artifact` fenced block in its
 * final reply (usage injected via agent-bridge.ts). Text WITHOUT the marker
 * never triggers an upload — no scanning of arbitrary local paths, markdown
 * images or URLs (issue #95 requirement). `kind` is the #27 (generic outbound
 * file attachment) extension point; V1 only recognizes "image" — blocks with
 * any other kind stay in the visible text untouched.
 *
 * V1 contract (README): all text segments are delivered first, then images in
 * block order. Every image/* format (incl. GIF) is sent as Image(type=2).
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from './media-inbound.js';

/** Fenced-block info string that marks an artifact instruction (exact match). */
export const ARTIFACT_FENCE_INFO = 'octo-artifact';

export interface ArtifactInstruction {
  kind: 'image';
  /** Raw path as written by the agent (relative to the session cwd, or absolute). */
  path: string;
  caption?: string;
}

export interface ExtractArtifactsResult {
  /** Visible text with recognized artifact blocks removed. Byte-identical to the input when no marker is present. */
  cleanText: string;
  /** Recognized image instructions in appearance order, deduped, capped at MAX_IMAGES_PER_MESSAGE. */
  artifacts: ArtifactInstruction[];
  /** Count of valid instructions removed by the per-message cap (not delivered). */
  dropped: number;
}

// Opening fence: up to 3 leading spaces, 3+ backticks/tildes, then the info string.
const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*\r?$/;

function closingFenceLength(line: string, fenceChar: string): number {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!m || m[1][0] !== fenceChar) return 0;
  return m[1].length;
}

/**
 * Parse one artifact block body (the lines between the fences). Returns null
 * for anything that is not exactly one JSON object with kind="image" and a
 * non-empty string path — callers keep null blocks in the text verbatim
 * (fail-safe: a malformed block must never swallow user-visible characters).
 */
function parseArtifactBlock(inner: string): ArtifactInstruction | null {
  try {
    const value: unknown = JSON.parse(inner.trim());
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (obj.kind !== 'image') return null;
    if (typeof obj.path !== 'string' || obj.path.trim() === '') return null;
    return typeof obj.caption === 'string'
      ? { kind: 'image', path: obj.path, caption: obj.caption }
      : { kind: 'image', path: obj.path };
  } catch {
    return null;
  }
}

/**
 * Extract `octo-artifact` fenced blocks from the final reply text.
 *
 * - Only blocks whose info string is EXACTLY `octo-artifact` are candidates.
 * - Bad JSON / non-image kind / unclosed fence → the block stays verbatim.
 * - Same resolved path twice → delivered once (dedup key: normalized path).
 * - More than MAX_IMAGES_PER_MESSAGE distinct images → first N win, the rest
 *   are removed from the text and counted in `dropped` (not delivered).
 */
export function extractArtifacts(text: string): ExtractArtifactsResult {
  // Fast path keeps the common no-artifact reply byte-identical without a scan.
  if (!text.includes(ARTIFACT_FENCE_INFO)) {
    return { cleanText: text, artifacts: [], dropped: 0 };
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  const artifacts: ArtifactInstruction[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  let i = 0;
  while (i < lines.length) {
    const open = OPEN_FENCE_RE.exec(lines[i]);
    if (!open) {
      kept.push(lines[i]);
      i++;
      continue;
    }
    const fenceChar = open[1][0];
    const fenceLen = open[1].length;
    // Locate the matching closing fence (same char, at least the same length).
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closingFenceLength(lines[j], fenceChar) >= fenceLen) { close = j; break; }
    }
    if (open[2] !== ARTIFACT_FENCE_INFO) {
      // Foreign code block: keep whole, and skip past it so fence-like lines
      // inside its body can never be mistaken for an artifact block.
      const end = close === -1 ? lines.length - 1 : close;
      for (let j = i; j <= end; j++) kept.push(lines[j]);
      i = end + 1;
      continue;
    }
    if (close === -1) {
      // Unclosed artifact block: keep verbatim (never swallow characters).
      for (let j = i; j < lines.length; j++) kept.push(lines[j]);
      i = lines.length;
      continue;
    }
    const parsed = parseArtifactBlock(lines.slice(i + 1, close).join('\n'));
    if (!parsed) {
      for (let j = i; j <= close; j++) kept.push(lines[j]);
      i = close + 1;
      continue;
    }
    // Dedup on the normalized path (resolve without a base only canonicalizes
    // ./a.png vs a.png; the containment check happens in prepareOutboundImage).
    const key = resolve(parsed.path);
    i = close + 1;
    if (seen.has(key)) continue;
    seen.add(key);
    if (artifacts.length >= MAX_IMAGES_PER_MESSAGE) { dropped++; continue; }
    artifacts.push(parsed);
  }
  return { cleanText: kept.join('\n'), artifacts, dropped };
}

// ─── Local validation (stage=validate) ─────────────────────────────────────

export type OutboundImageStage = 'validate' | 'presign' | 'put' | 'send';

/**
 * Per-image delivery outcome. `error` is a sanitized `stage:reason` tag —
 * it must never carry URLs, signature query strings, tokens or raw exception
 * text (issue #95: credentials never reach diagnostics).
 */
export interface OutboundImageResult {
  state: 'sent' | 'failed' | 'unknown';
  stage: OutboundImageStage;
  name?: string;
  error?: string;
}

export interface PreparedImage {
  /** Upload/message display name (basename only — never leaks directory info). */
  name: string;
  size: number;
  /** Sniffed from magic bytes, NOT from the file extension. */
  contentType: string;
  width?: number;
  height?: number;
  caption?: string;
  /**
   * Full file content, read once at prepare time so the presign `fileSize`
   * and the PUT body are guaranteed identical (SigV4 signs Content-Length;
   * any mismatch is a 403). Bounded by MAX_IMAGE_BYTES.
   */
  body: Buffer;
}

export type PrepareOutcome =
  | { ok: true; image: PreparedImage }
  | { ok: false; result: OutboundImageResult };

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Validate one artifact instruction against the session cwd sandbox and load
 * the image. Chain: path containment (logical + realpath, blocks ../ and
 * symlink escape) → regular file ≤ MAX_IMAGE_BYTES → magic-byte type sniff
 * (blocks renamed text) → header dimension parse (best effort).
 * Every rejection carries stage='validate' and a fixed reason tag.
 */
export async function prepareOutboundImage(params: {
  artifact: ArtifactInstruction;
  cwdDir: string;
}): Promise<PrepareOutcome> {
  const { artifact, cwdDir } = params;
  const name = basename(artifact.path);
  const reject = (reason: 'path_escape' | 'not_found' | 'too_large' | 'not_image' | 'read_error'): PrepareOutcome => ({
    ok: false,
    result: { state: 'failed', stage: 'validate', name, error: `validate:${reason}` },
  });

  const resolved = resolve(cwdDir, artifact.path);
  if (!isWithin(cwdDir, resolved)) return reject('path_escape');
  let real: string;
  let baseReal: string;
  try {
    [real, baseReal] = await Promise.all([realpath(resolved), realpath(cwdDir)]);
  } catch {
    return reject('not_found');
  }
  // realpath may resolve a symlink out of the sandbox even when the logical path is inside.
  if (!isWithin(baseReal, real)) return reject('path_escape');

  try {
    const st = await stat(real);
    if (!st.isFile()) return reject('not_found');
    // Stat before reading so an oversize file is rejected without buffering it.
    if (st.size > MAX_IMAGE_BYTES) return reject('too_large');
    const body = await readFile(real);
    if (body.byteLength === 0) return reject('not_image');
    if (body.byteLength > MAX_IMAGE_BYTES) return reject('too_large');
    const contentType = sniffImageType(body);
    if (!contentType) return reject('not_image');
    const dims = parseImageDimensions(body, contentType);
    return {
      ok: true,
      image: {
        name,
        size: body.byteLength,
        contentType,
        ...(dims ?? {}),
        ...(artifact.caption !== undefined ? { caption: artifact.caption } : {}),
        body,
      },
    };
  } catch {
    return reject('read_error');
  }
}

/** Magic-byte sniff for the four supported formats; null for anything else. */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Parse PNG/JPEG/GIF/WebP dimensions from header bytes.
 * Ported from openclaw-channel-octo v1.0.13 (parseImageDimensions) — zero
 * external dependencies. Best effort: null just means the payload omits
 * width/height (both are omitempty in the server's ImagePayload contract).
 */
export function parseImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length > 24) {
      // PNG IHDR: width at offset 16, height at 20 (4 bytes BE each).
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg' && buf.length > 2) {
      // JPEG: walk segments until SOF0/SOF2 (0xFFC0 / 0xFFC2).
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
    if (mime === 'image/gif' && buf.length > 10) {
      // GIF logical screen size: width at 6, height at 8 (2 bytes LE each).
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/webp' && buf.length > 30 && buf.toString('ascii', 12, 16) === 'VP8 ') {
      // WebP lossy VP8: 14-bit dimensions at 26/28 (2 bytes LE each).
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch { /* dimension parse is best effort */ }
  return null;
}
