/**
 * media-outbound tests (#95 native outbound images).
 *
 * Covers: octo-artifact block extraction (happy / malformed / over-cap /
 * dedup / foreign fence / unclosed) and the local validation chain
 * (missing file, renamed text, oversize, path escape incl. symlink).
 * Test images are hand-built magic-byte buffers — no real encoders, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractArtifacts,
  prepareOutboundImage,
  parseImageDimensions,
  sniffImageType,
  type ArtifactInstruction,
} from '../media-outbound.js';
import { MAX_IMAGE_BYTES } from '../media-inbound.js';

// ─── Fixture builders ───────────────────────────────────────────────────────

/** Minimal PNG: 8-byte magic + IHDR with width/height at offsets 16/20 (BE). */
function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt8(0x89, 0);
  buf.write('PNG', 1, 'ascii');
  buf.writeUInt8(0x0d, 4); buf.writeUInt8(0x0a, 5);
  buf.writeUInt8(0x1a, 6); buf.writeUInt8(0x0a, 7);
  buf.writeUInt32BE(13, 8);          // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Minimal GIF89a: logical screen size at offsets 6/8 (LE). */
function gifBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Minimal JPEG: SOI + APP0 segment + SOF0 with height at 25 / width at 27 (BE). */
function jpegBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeUInt8(0xff, 0); buf.writeUInt8(0xd8, 1);           // SOI
  buf.writeUInt8(0xff, 2); buf.writeUInt8(0xe0, 3);           // APP0
  buf.writeUInt16BE(16, 4);                                   // APP0 length → next marker at 20
  buf.writeUInt8(0xff, 20); buf.writeUInt8(0xc0, 21);         // SOF0
  buf.writeUInt16BE(17, 22);
  buf.writeUInt8(8, 24);                                      // precision
  buf.writeUInt16BE(height, 25);
  buf.writeUInt16BE(width, 27);
  return buf;
}

/** Minimal WebP (lossy VP8): 14-bit dimensions at offsets 26/28 (LE). */
function webpBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

function block(path: string, caption?: string): string {
  const json = caption !== undefined
    ? JSON.stringify({ kind: 'image', path, caption })
    : JSON.stringify({ kind: 'image', path });
  return '```octo-artifact\n' + json + '\n```';
}

// ─── extractArtifacts ───────────────────────────────────────────────────────

describe('extractArtifacts', () => {
  it('case 1: extracts one artifact block and strips it from cleanText', () => {
    const text = `前言\n\n${block('charts/out.png', '图表')}\n\n后记`;
    const r = extractArtifacts(text);
    expect(r.artifacts).toEqual([{ kind: 'image', path: 'charts/out.png', caption: '图表' }]);
    expect(r.dropped).toBe(0);
    expect(r.cleanText).not.toContain('octo-artifact');
    expect(r.cleanText).not.toContain('charts/out.png');
    expect(r.cleanText).toContain('前言');
    expect(r.cleanText).toContain('后记');
  });

  it('case 2: malformed JSON block stays verbatim and triggers nothing', () => {
    const bad = '```octo-artifact\n{"kind":"image",\n```';
    const text = `before\n${bad}\nafter`;
    const r = extractArtifacts(text);
    expect(r.artifacts).toEqual([]);
    expect(r.dropped).toBe(0);
    // Fail-safe: the raw block is preserved byte-for-byte (never swallow characters).
    expect(r.cleanText).toBe(text);
  });

  it('case 2b: valid JSON but non-image kind stays verbatim (#27 extension point)', () => {
    const fileBlock = '```octo-artifact\n{"kind":"file","path":"report.pdf"}\n```';
    const r = extractArtifacts(`text\n${fileBlock}`);
    expect(r.artifacts).toEqual([]);
    expect(r.cleanText).toContain(fileBlock);
  });

  it('case 3: caps at 6 images per reply, drops the rest', () => {
    const blocks = Array.from({ length: 7 }, (_, i) => block(`img${i + 1}.png`)).join('\n\n');
    const r = extractArtifacts(`intro\n${blocks}`);
    expect(r.artifacts.map(a => a.path)).toEqual([
      'img1.png', 'img2.png', 'img3.png', 'img4.png', 'img5.png', 'img6.png',
    ]);
    expect(r.dropped).toBe(1);
    // The over-cap block is removed from the body too (deterministic truncation).
    expect(r.cleanText).not.toContain('img7.png');
    expect(r.cleanText).toContain('intro');
  });

  it('dedupes the same resolved path (./a.png == a.png)', () => {
    const r = extractArtifacts(`${block('./a.png')}\n${block('a.png')}`);
    expect(r.artifacts).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it('recognizes tilde fences and rejects inexact info strings', () => {
    const tilde = '~~~octo-artifact\n{"kind":"image","path":"t.png"}\n~~~';
    expect(extractArtifacts(tilde).artifacts).toEqual([{ kind: 'image', path: 't.png' }]);

    const nearMiss = '```octo-artifacts\n{"kind":"image","path":"x.png"}\n```';
    const r = extractArtifacts(nearMiss);
    expect(r.artifacts).toEqual([]);
    expect(r.cleanText).toBe(nearMiss);
  });

  it('keeps an unclosed artifact block verbatim', () => {
    const unclosed = '```octo-artifact\n{"kind":"image","path":"x.png"}';
    const r = extractArtifacts(unclosed);
    expect(r.artifacts).toEqual([]);
    expect(r.cleanText).toBe(unclosed);
  });

  it('never mistakes fence-like lines inside a foreign code block', () => {
    const foreign = '```ts\nconst info = "octo-artifact";\n// ```octo-artifact\n```';
    const r = extractArtifacts(`code:\n${foreign}\ndone`);
    expect(r.artifacts).toEqual([]);
    expect(r.cleanText).toContain(foreign);
  });

  it('fast path: text without the marker is returned byte-identical', () => {
    const text = 'plain reply with a path like charts/out.png and ![md](img.png)';
    const r = extractArtifacts(text);
    expect(r.cleanText).toBe(text);
    expect(r.artifacts).toEqual([]);
    expect(r.dropped).toBe(0);
  });
});

// ─── sniff / dimensions ─────────────────────────────────────────────────────

describe('sniffImageType / parseImageDimensions', () => {
  it('sniffs the four supported formats by magic bytes', () => {
    expect(sniffImageType(pngBuffer(1, 1))).toBe('image/png');
    expect(sniffImageType(jpegBuffer(1, 1))).toBe('image/jpeg');
    expect(sniffImageType(gifBuffer(1, 1))).toBe('image/gif');
    expect(sniffImageType(webpBuffer(1, 1))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('not an image at all'))).toBeNull();
  });

  it('parses dimensions from headers', () => {
    expect(parseImageDimensions(pngBuffer(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(parseImageDimensions(gifBuffer(100, 50), 'image/gif')).toEqual({ width: 100, height: 50 });
    expect(parseImageDimensions(jpegBuffer(300, 200), 'image/jpeg')).toEqual({ width: 300, height: 200 });
    expect(parseImageDimensions(webpBuffer(320, 240), 'image/webp')).toEqual({ width: 320, height: 240 });
  });
});

// ─── prepareOutboundImage (validation chain, stage=validate) ───────────────

describe('prepareOutboundImage', () => {
  let cwd: string;
  let outside: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cc-out-img-'));
    outside = mkdtempSync(join(tmpdir(), 'cc-out-escape-'));
    mkdirSync(join(cwd, 'charts'), { recursive: true });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const artifact = (path: string, caption?: string): ArtifactInstruction =>
    caption !== undefined ? { kind: 'image', path, caption } : { kind: 'image', path };

  it('prepares a valid PNG: sniffed type, parsed dimensions, exact body', async () => {
    const png = pngBuffer(640, 480);
    writeFileSync(join(cwd, 'charts', 'out.png'), png);
    const r = await prepareOutboundImage({ artifact: artifact('charts/out.png', '图表'), cwdDir: cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.name).toBe('out.png');
      expect(r.image.contentType).toBe('image/png');
      expect(r.image.width).toBe(640);
      expect(r.image.height).toBe(480);
      expect(r.image.size).toBe(png.length);
      expect(r.image.caption).toBe('图表');
      expect(r.image.body.equals(png)).toBe(true);
    }
  });

  it('prepares a GIF as image/gif (V1: all image/* go out as Image type=2)', async () => {
    writeFileSync(join(cwd, 'anim.gif'), gifBuffer(100, 50));
    const r = await prepareOutboundImage({ artifact: artifact('anim.gif'), cwdDir: cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.contentType).toBe('image/gif');
      expect(r.image.width).toBe(100);
      expect(r.image.height).toBe(50);
    }
  });

  it('case 5: missing file → failed(validate:not_found), no network touched', async () => {
    const r = await prepareOutboundImage({ artifact: artifact('nope.png'), cwdDir: cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result).toMatchObject({ state: 'failed', stage: 'validate', name: 'nope.png' });
      expect(r.result.error).toContain('validate');
      expect(r.result.error).not.toContain(cwd);   // sanitized: no local paths
    }
    expect(fetchSpy).not.toHaveBeenCalled();       // presign never reached
  });

  it('case 6: renamed text file (.png) → rejected by magic bytes', async () => {
    writeFileSync(join(cwd, 'fake.png'), 'this is definitely not a PNG');
    const r = await prepareOutboundImage({ artifact: artifact('fake.png'), cwdDir: cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.stage).toBe('validate');
      expect(r.result.error).toBe('validate:not_image');
    }
  });

  it('case 7: oversize file (> 5MB) → rejected before buffering', async () => {
    // Valid PNG header padded past the cap — size check must fire before content.
    const big = Buffer.concat([pngBuffer(1, 1), Buffer.alloc(MAX_IMAGE_BYTES)]);
    writeFileSync(join(cwd, 'big.png'), big);
    const r = await prepareOutboundImage({ artifact: artifact('big.png'), cwdDir: cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.stage).toBe('validate');
      expect(r.result.error).toBe('validate:too_large');
    }
  });

  it('case 8: ../ escape → path_escape without touching the target', async () => {
    const r = await prepareOutboundImage({ artifact: artifact('../../etc/passwd'), cwdDir: cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.stage).toBe('validate');
      expect(r.result.error).toBe('validate:path_escape');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('case 8b: symlink pointing outside the cwd → path_escape even with valid image content', async () => {
    const realPng = join(outside, 'real.png');
    writeFileSync(realPng, pngBuffer(8, 8));
    symlinkSync(realPng, join(cwd, 'link.png'));
    const r = await prepareOutboundImage({ artifact: artifact('link.png'), cwdDir: cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.error).toBe('validate:path_escape');
    }
  });

  it('accepts an absolute path that stays inside the cwd', async () => {
    writeFileSync(join(cwd, 'charts', 'abs.png'), pngBuffer(4, 4));
    const r = await prepareOutboundImage({ artifact: artifact(join(cwd, 'charts', 'abs.png')), cwdDir: cwd });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.name).toBe('abs.png');
  });

  it('rejects a directory as not_found', async () => {
    const r = await prepareOutboundImage({ artifact: artifact('charts'), cwdDir: cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.result.error).toBe('validate:not_found');
  });
});
