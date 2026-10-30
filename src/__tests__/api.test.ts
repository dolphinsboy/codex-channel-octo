/**
 * Tests for octo/api.ts — getUploadCredentials.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  getUploadCredentials,
  sendReadReceipt,
  getUploadPresign,
  uploadFileToPresignedUrl,
  sendImageMessage,
} from '../octo/api.js';
import { ChannelType } from '../octo/types.js';

// Mock global fetch
const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function mockJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockErrorResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: 'Error' });
}

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };

describe('getUploadCredentials', () => {
  it('parses full credentials response', async () => {
    const mock = {
      bucket: 'my-bucket', region: 'ap-shanghai', key: 'path/to/file.png',
      credentials: {
        tmpSecretId: 'tmp-id', tmpSecretKey: 'tmp-key', sessionToken: 'tok',
      },
      startTime: 1000, expiredTime: 4600,
      cdnBaseUrl: 'https://cdn.example.com',
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(mock));

    const result = await getUploadCredentials({ ...BASE, filename: 'file.png' });
    expect(result.bucket).toBe('my-bucket');
    expect(result.credentials.tmpSecretId).toBe('tmp-id');
    expect(result.cdnBaseUrl).toBe('https://cdn.example.com');
  });

  it('URL-encodes filename in query string', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      bucket: 'b', region: 'r', key: 'k',
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
      startTime: 1, expiredTime: 2,
    }));

    await getUploadCredentials({ ...BASE, filename: 'spaces in name.png' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('filename=spaces%20in%20name.png');
  });

  it('throws on missing top-level field', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      bucket: 'b', region: 'r',
      // key missing
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
    }));

    await expect(getUploadCredentials({ ...BASE, filename: 'x.png' }))
      .rejects.toThrow(/incomplete response.*key/);
  });

  it('throws on missing credentials field', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      bucket: 'b', region: 'r', key: 'k',
      credentials: { tmpSecretId: 'i' /* tmpSecretKey, sessionToken missing */ },
    }));

    await expect(getUploadCredentials({ ...BASE, filename: 'x.png' }))
      .rejects.toThrow(/incomplete credentials/);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(403, 'Forbidden'));
    await expect(getUploadCredentials({ ...BASE, filename: 'x.png' }))
      .rejects.toThrow(/failed \(403\)/);
  });

  it('withholds Bearer token and server body (P1 from PR#34 review)', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(
      401,
      'unauthorized: Authorization: Bearer bf_secret_token_12345',
    ));
    let captured: Error | undefined;
    try {
      await getUploadCredentials({ ...BASE, filename: 'x.png' });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    // Token MUST NOT appear in the surfaced error message.
    expect(captured!.message).not.toContain('bf_secret_token_12345');
    expect(captured!.message).toContain('/v1/bot/upload/credentials');
    expect(captured).toMatchObject({ snapshot: { stage: 'prepare', category: 'auth', httpStatus: 401 } });
  });

  it('withholds JSON-quoted authorization header', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(
      500,
      '{"error":"oops","authorization":"bf_secret_in_json"}',
    ));
    let captured: Error | undefined;
    try {
      await getUploadCredentials({ ...BASE, filename: 'x.png' });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).not.toContain('bf_secret_in_json');
    expect(captured).toMatchObject({ snapshot: { stage: 'prepare', category: 'api_failed', httpStatus: 500 } });
  });

  it('caps error body at 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    fetchMock.mockResolvedValueOnce(mockErrorResponse(500, longBody));
    let captured: Error | undefined;
    try {
      await getUploadCredentials({ ...BASE, filename: 'x.png' });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    // Error prefix + 200 chars max + nothing more
    expect(captured!.message.length).toBeLessThan(300);
    expect(captured!.message).not.toMatch(/x{300,}/);
  });
});

describe('sendReadReceipt — message_ids guard', () => {
  const RR_BASE = {
    apiUrl: 'https://api.example.com',
    botToken: 'test-token',
    channelId: 'chan-1',
    channelType: ChannelType.DM,
  };

  function bodyOf(callIndex = 0): Record<string, unknown> {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it('includes message_ids when non-empty', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: ['123', '456'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf()).toMatchObject({ message_ids: ['123', '456'] });
  });

  it('omits message_ids when the array is empty', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect('message_ids' in bodyOf()).toBe(false);
    // still clears the unread badge — channel_id is present
    expect(bodyOf()).toMatchObject({ channel_id: 'chan-1' });
  });

  it('omits message_ids when every id is empty or blank', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: ['', '   '] });
    expect('message_ids' in bodyOf()).toBe(false);
  });

  it('filters out blank ids and keeps the real ones', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: ['x', '', '  '] });
    expect(bodyOf()).toMatchObject({ message_ids: ['x'] });
  });
});

// ─── #95: presigned upload + native image message ───────────────────────────

describe('getUploadPresign (#95)', () => {
  const PRESIGN_RESPONSE = {
    method: 'PUT',
    uploadUrl: 'https://storage.test/bucket/key.png?X-Amz-Signature=SIG_VALUE_SHOULD_NOT_LEAK',
    downloadUrl: 'https://cdn.test/media/key.png',
    contentType: 'image/png',
    contentDisposition: 'attachment; filename="key.png"',
    key: 'bot/key.png',
    expiresIn: 1800,
  };

  it('sends filename/fileSize/contentType in the query and parses the response', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse(PRESIGN_RESPONSE));
    const r = await getUploadPresign({ ...BASE, filename: 'key.png', fileSize: 1234, contentType: 'image/png' });
    expect(r).toEqual({
      uploadUrl: PRESIGN_RESPONSE.uploadUrl,
      downloadUrl: PRESIGN_RESPONSE.downloadUrl,
      contentType: 'image/png',
      contentDisposition: PRESIGN_RESPONSE.contentDisposition,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/v1/bot/upload/presigned?');
    expect(url).toContain('filename=key.png');
    expect(url).toContain('fileSize=1234');
    expect(url).toContain('contentType=image%2Fpng');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bf_test');
  });

  it('rejects invalid fileSize before any request', async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(getUploadPresign({ ...BASE, filename: 'x.png', fileSize: bad }))
        .rejects.toThrow(/positive integer fileSize/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HTTP failure → structured AgentFailure, server body never echoed', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(403, 'SignatureDoesNotMatch tmpSecretKey=SECRET_KEY_IN_BODY'));
    let captured: Error | undefined;
    try {
      await getUploadPresign({ ...BASE, filename: 'x.png', fileSize: 10 });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).not.toContain('SECRET_KEY_IN_BODY');
    expect(captured!.message).toContain('/v1/bot/upload/presigned');
    expect(captured).toMatchObject({ snapshot: { endpoint: '/v1/bot/upload/presigned', category: 'permission', httpStatus: 403 } });
  });

  it('incomplete response names the missing fields', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ downloadUrl: 'https://cdn.test/x' }));
    await expect(getUploadPresign({ ...BASE, filename: 'x.png', fileSize: 10 }))
      .rejects.toThrow(/incomplete response.*uploadUrl/);
  });
});

describe('uploadFileToPresignedUrl (#95)', () => {
  const UPLOAD_URL = 'https://storage.test/bucket/key.png?X-Amz-Signature=SIG_VALUE_SHOULD_NOT_LEAK&x-session-token=TOKEN_SHOULD_NOT_LEAK';
  const DOWNLOAD_URL = 'https://cdn.test/media/key.png';
  const body = Buffer.from('png-bytes');

  it('PUTs the exact body with verbatim signed headers and returns downloadUrl', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const r = await uploadFileToPresignedUrl({
      uploadUrl: UPLOAD_URL, downloadUrl: DOWNLOAD_URL, fileBody: body, fileSize: body.length,
      contentType: 'image/png', contentDisposition: 'attachment; filename="key.png"',
    });
    expect(r).toEqual({ url: DOWNLOAD_URL });
    const url = fetchMock.mock.calls[0][0] as string;
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toBe(UPLOAD_URL);
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Length']).toBe(String(body.length));
    expect(headers['Content-Disposition']).toBe('attachment; filename="key.png"');
    expect(init.body).toBe(body);
  });

  it('omits Content-Disposition when the presign did not sign one', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await uploadFileToPresignedUrl({
      uploadUrl: UPLOAD_URL, downloadUrl: DOWNLOAD_URL, fileBody: body, fileSize: body.length, contentType: 'image/png',
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect('Content-Disposition' in (init.headers as Record<string, string>)).toBe(false);
  });

  it('PUT failure never leaks the signed URL or the storage error body', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(
      403,
      'SignatureDoesNotMatch X-Amz-Signature=SIG_VALUE_SHOULD_NOT_LEAK sessionToken=TOKEN_SHOULD_NOT_LEAK',
    ));
    let captured: Error | undefined;
    try {
      await uploadFileToPresignedUrl({
        uploadUrl: UPLOAD_URL, downloadUrl: DOWNLOAD_URL, fileBody: body, fileSize: body.length, contentType: 'image/png',
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).not.toContain('SIG_VALUE_SHOULD_NOT_LEAK');
    expect(captured!.message).not.toContain('TOKEN_SHOULD_NOT_LEAK');
    expect(captured).toMatchObject({ snapshot: { endpoint: '/v1/bot/upload/presigned', category: 'permission', httpStatus: 403, detail: 'http_status' } });
  });

  it('network failure → structured network_transient without URL details', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(
      new TypeError('fetch failed'),
      { cause: new Error(`connect ECONNREFUSED ${UPLOAD_URL}`) },
    ));
    let captured: Error | undefined;
    try {
      await uploadFileToPresignedUrl({
        uploadUrl: UPLOAD_URL, downloadUrl: DOWNLOAD_URL, fileBody: body, fileSize: body.length, contentType: 'image/png',
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).not.toContain('SIG_VALUE_SHOULD_NOT_LEAK');
    expect(captured).toMatchObject({ snapshot: { endpoint: '/v1/bot/upload/presigned', category: 'network_transient', detail: 'network' } });
  });

  it('abort → AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('This operation was aborted', 'AbortError'));
    await expect(uploadFileToPresignedUrl({
      uploadUrl: UPLOAD_URL, downloadUrl: DOWNLOAD_URL, fileBody: body, fileSize: body.length,
      contentType: 'image/png', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('sendImageMessage (#95)', () => {
  const IMG_BASE = { apiUrl: BASE.apiUrl, botToken: BASE.botToken, channelId: 'chan-1', channelType: ChannelType.DM };

  function bodyOf(callIndex = 0): Record<string, unknown> {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it('posts an Image(type=2) payload with url/width/height/name/size/caption', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ message_id: '9001', client_msg_no: 'cmn', message_seq: 3 }));
    const r = await sendImageMessage({
      ...IMG_BASE, url: 'https://cdn.test/a.png', name: 'a.png', size: 1234,
      width: 640, height: 480, caption: 'chart', clientMsgNo: 'fixed-no',
    });
    expect(r?.message_id).toBe('9001');
    const body = bodyOf();
    expect(body.channel_id).toBe('chan-1');
    expect(body.channel_type).toBe(ChannelType.DM);
    expect(body.client_msg_no).toBe('fixed-no');
    expect(body.payload).toEqual({
      type: 2, // MessageType.Image — the mock server's canonical wire type
      url: 'https://cdn.test/a.png', name: 'a.png', size: 1234, width: 640, height: 480, caption: 'chart',
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.endsWith('/v1/bot/sendMessage')).toBe(true);
  });

  it('omits optional metadata when absent', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ message_id: '9002', client_msg_no: 'c', message_seq: 1 }));
    await sendImageMessage({ ...IMG_BASE, url: 'https://cdn.test/b.png' });
    expect(bodyOf().payload).toEqual({ type: 2, url: 'https://cdn.test/b.png' });
  });

  it('generates a client_msg_no when none is provided', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ message_id: '9003', client_msg_no: 'c', message_seq: 1 }));
    await sendImageMessage({ ...IMG_BASE, url: 'https://cdn.test/c.png' });
    const no = bodyOf().client_msg_no as string;
    expect(typeof no).toBe('string');
    expect(no.length).toBeGreaterThan(10);
  });
});
