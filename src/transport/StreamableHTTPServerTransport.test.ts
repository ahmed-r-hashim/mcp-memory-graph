import { EventEmitter } from 'events';
import { StreamableHTTPServerTransport } from './StreamableHTTPServerTransport.js';

describe('StreamableHTTPServerTransport', () => {
  it('keeps a pending POST response alive when the request stream closes', async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => 'generated-session',
      eventStore: new Map(),
    });

    const req = createMockRequest('POST', {
      'x-mcp-session-id': 'session-1',
    });
    const res = createMockResponse();
    const body = {
      jsonrpc: '2.0' as const,
      id: 0,
      method: 'ping',
      params: {},
    };

    await transport.handleRequest(req as any, res as any, body);

    req.emit('close');
    await transport.send({
      jsonrpc: '2.0',
      id: 0,
      result: { ok: true },
    });

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 0,
      result: { ok: true },
    });
  });

  describe('behaviour', () => {
    const originalEnv = {
      debug: process.env.MCP_HTTP_DEBUG,
      timeout: process.env.MCP_HTTP_TIMEOUT_WARNING_MS,
    };
    let errorSpy: jest.SpyInstance;

    const makeTransport = (eventStore = new Map<string, any[]>()) =>
      new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'generated', eventStore });
    const request = (id: number | undefined, method?: string) =>
      ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), ...(method ? { method } : {}) } as any);

    beforeEach(() => {
      delete process.env.MCP_HTTP_DEBUG;
      delete process.env.MCP_HTTP_TIMEOUT_WARNING_MS;
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
      errorSpy.mockRestore();
      if (originalEnv.debug === undefined) delete process.env.MCP_HTTP_DEBUG; else process.env.MCP_HTTP_DEBUG = originalEnv.debug;
      if (originalEnv.timeout === undefined) delete process.env.MCP_HTTP_TIMEOUT_WARNING_MS; else process.env.MCP_HTTP_TIMEOUT_WARNING_MS = originalEnv.timeout;
    });

    it('start is a no-op and sessionId is undefined before a request', async () => {
      const transport = makeTransport();
      await expect(transport.start()).resolves.toBeUndefined();
      expect(transport.sessionId).toBeUndefined();
    });

    it.each([
      [undefined, 10000],
      ['abc', 10000],
      ['-5', 10000],
      ['250', 250],
    ])('parses timeout warning %p as %p', (raw, expected) => {
      if (raw !== undefined) process.env.MCP_HTTP_TIMEOUT_WARNING_MS = raw;
      expect((makeTransport() as any).timeoutWarningMs).toBe(expected);
    });

    describe('handleRequest', () => {
      it('answers OPTIONS preflight with CORS headers', async () => {
        const res = createMockResponse();
        await makeTransport().handleRequest(createMockRequest('OPTIONS') as any, res as any, undefined as any);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalled();
      });

      it('answers HEAD without creating a session', async () => {
        const transport = makeTransport();
        const res = createMockResponse();
        await transport.handleRequest(createMockRequest('HEAD') as any, res as any, undefined as any);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(transport.sessionId).toBeUndefined();
      });

      it('returns a status document for GET without an event-stream Accept header', async () => {
        const transport = makeTransport();
        const res = createMockResponse();
        await transport.handleRequest(createMockRequest('GET') as any, res as any, undefined as any);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ status: 'ok', transport: 'streamable-http', endpoint: '/mcp' });
        expect(res.headers.get('X-MCP-Session-ID')).toBe('generated');
      });

      it('opens an SSE stream, replays stored events and cleans up on close', async () => {
        const eventStore = new Map<string, any[]>([['s1', [{ jsonrpc: '2.0', method: 'stored' }]]]);
        const transport = makeTransport(eventStore);
        transport.onclose = jest.fn();
        const req = createMockRequest('GET', { 'x-mcp-session-id': 's1', accept: 'text/event-stream' });
        const res = createMockResponse();

        await transport.handleRequest(req as any, res as any, undefined as any);

        expect(res.headers.get('Content-Type')).toBe('text/event-stream');
        expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'stored' })}\n\n`);
        expect(eventStore.has('s1')).toBe(false);
        expect(transport.sessionId).toBe('s1');

        await transport.send({ jsonrpc: '2.0', method: 'live' });
        expect(res.write).toHaveBeenLastCalledWith(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'live' })}\n\n`);

        req.emit('close');
        expect(transport.sessionId).toBeUndefined();
        expect(transport.onclose).toHaveBeenCalled();
      });

      it('keeps the current session id when a different session closes, without an onclose handler', async () => {
        const transport = makeTransport();
        const reqA = createMockRequest('GET', { 'x-mcp-session-id': 'a', accept: 'text/event-stream' });
        const reqB = createMockRequest('GET', { 'x-mcp-session-id': 'b', accept: 'text/event-stream' });
        await transport.handleRequest(reqA as any, createMockResponse() as any, undefined as any);
        await transport.handleRequest(reqB as any, createMockResponse() as any, undefined as any);

        reqA.emit('close');
        expect(transport.sessionId).toBe('b');
      });

      it('dispatches notifications to onmessage and replies 202', async () => {
        const transport = makeTransport();
        transport.onmessage = jest.fn();
        const res = createMockResponse();
        const body = request(undefined, 'notifications/initialized');

        await transport.handleRequest(createMockRequest('POST') as any, res as any, body);

        expect(transport.onmessage).toHaveBeenCalledWith(body);
        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.end).toHaveBeenCalled();
      });

      it('treats a body with an id but no method as a response (202)', async () => {
        const res = createMockResponse();
        await makeTransport().handleRequest(createMockRequest('POST') as any, res as any, request(5));
        expect(res.status).toHaveBeenCalledWith(202);
      });

      it('holds requests open without an onmessage handler and clears them when the connection closes', async () => {
        const transport = makeTransport();
        const res = createMockResponse();
        await transport.handleRequest(createMockRequest('POST') as any, res as any, request(7, 'ping'));

        expect(res.status).not.toHaveBeenCalled();
        expect((transport as any).pendingResponses.has(7)).toBe(true);

        res.emit('close');
        expect((transport as any).pendingResponses.has(7)).toBe(false);
        expect((transport as any).pendingResponseTimers.has(7)).toBe(false);

        // A second close after the response is gone is ignored
        expect(() => res.emit('close')).not.toThrow();
      });

      it('rejects unsupported methods with 405 and reports via onerror', async () => {
        const transport = makeTransport();
        transport.onerror = jest.fn();
        const res = createMockResponse();

        await transport.handleRequest(createMockRequest('DELETE') as any, res as any, undefined as any);

        expect(transport.onerror).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('DELETE') }));
        expect(res.status).toHaveBeenCalledWith(405);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: null }));
      });

      it('rejects unsupported methods when no onerror handler is set', async () => {
        const res = createMockResponse();
        await makeTransport().handleRequest(createMockRequest('PUT') as any, res as any, null as any);
        expect(res.status).toHaveBeenCalledWith(405);
      });
    });

    describe('send', () => {
      it('throws when there is no active session', async () => {
        await expect(makeTransport().send({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('No active session');
      });

      it('buffers messages when the session has no open stream', async () => {
        const eventStore = new Map<string, any[]>();
        const transport = makeTransport(eventStore);
        await transport.handleRequest(createMockRequest('POST', { 'x-mcp-session-id': 's' }) as any, createMockResponse() as any, request(undefined, 'n'));

        await transport.send({ jsonrpc: '2.0', method: 'one' });
        await transport.send({ jsonrpc: '2.0', method: 'two' });

        expect(eventStore.get('s')).toHaveLength(2);
      });

      it('falls through to the session when the id has no pending response', async () => {
        const eventStore = new Map<string, any[]>();
        const transport = makeTransport(eventStore);
        await transport.handleRequest(createMockRequest('POST', { 'x-mcp-session-id': 's' }) as any, createMockResponse() as any, request(undefined, 'n'));

        await transport.send({ jsonrpc: '2.0', id: 99, result: {} });
        expect(eventStore.get('s')).toHaveLength(1);
      });
    });

    describe('close', () => {
      it('ends sessions, clears timers and state, and notifies onclose', async () => {
        const eventStore = new Map<string, any[]>([['other', []]]);
        const transport = makeTransport(eventStore);
        transport.onclose = jest.fn();

        const sse = createMockResponse();
        await transport.handleRequest(
          createMockRequest('GET', { 'x-mcp-session-id': 's', accept: 'text/event-stream' }) as any, sse as any, undefined as any);
        await transport.handleRequest(createMockRequest('POST') as any, createMockResponse() as any, request(1, 'ping'));

        await transport.close();

        expect(sse.end).toHaveBeenCalled();
        expect((transport as any).pendingResponses.size).toBe(0);
        expect((transport as any).pendingResponseTimers.size).toBe(0);
        expect(eventStore.size).toBe(0);
        expect(transport.sessionId).toBeUndefined();
        expect(transport.onclose).toHaveBeenCalled();
      });

      it('works without an onclose handler', async () => {
        await expect(makeTransport().close()).resolves.toBeUndefined();
      });
    });

    describe('debug logging', () => {
      beforeEach(() => {
        process.env.MCP_HTTP_DEBUG = 'true';
      });

      it('logs the request lifecycle to stderr', async () => {
        const transport = makeTransport();
        await transport.handleRequest(createMockRequest('POST') as any, createMockResponse() as any, request(1, 'ping'));
        await transport.send({ jsonrpc: '2.0', id: 1, result: {} });

        const logged = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
        expect(logged).toContain('[MCP HTTP DEBUG] Handling MCP HTTP request');
        expect(logged).toContain('Tracking pending JSON-RPC response');
        expect(logged).toContain('Sending JSON-RPC response on pending POST connection');
      });

      it('logs SSE, buffering and drop events', async () => {
        const transport = makeTransport();
        await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow();

        const req = createMockRequest('GET', { 'x-mcp-session-id': 's', accept: 'text/event-stream' });
        await transport.handleRequest(req as any, createMockResponse() as any, undefined as any);
        await transport.send({ jsonrpc: '2.0', method: 'live' });
        req.emit('close');

        const post = createMockRequest('POST', { 'x-mcp-session-id': 't' });
        await transport.handleRequest(post as any, createMockResponse() as any, request(undefined, 'n'));
        await transport.send({ jsonrpc: '2.0', method: 'buffered' });

        const logged = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
        expect(logged).toContain('Dropping outbound message because no active session exists');
        expect(logged).toContain('Opening SSE session');
        expect(logged).toContain('Sending outbound event on active session stream');
        expect(logged).toContain('SSE session closed');
        expect(logged).toContain('Buffered outbound event because session stream is not active');
        expect(logged).toContain('Completed non-request POST with 202 response');
      });

      it('logs when a POST connection closes early and when a pending response stays open', async () => {
        jest.useFakeTimers();
        process.env.MCP_HTTP_TIMEOUT_WARNING_MS = '100';
        const transport = makeTransport();
        const res = createMockResponse();
        await transport.handleRequest(createMockRequest('POST') as any, res as any, request(1, 'ping'));

        jest.advanceTimersByTime(100);
        res.emit('close');

        const logged = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
        expect(logged).toContain('Pending JSON-RPC response still open');
        expect(logged).toContain('POST connection closed before JSON-RPC response completed');
      });

      it('logs a null request id and accept header when absent', async () => {
        const transport = makeTransport();
        await transport.handleRequest(createMockRequest('POST') as any, createMockResponse() as any, { jsonrpc: '2.0' } as any);
        const logged = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
        expect(logged).toContain('"requestId":null');
        expect(logged).toContain('"accept":null');
      });
    });
  });
});

function createMockRequest(method: string, headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    headers: Record<string, string>;
  };

  req.method = method;
  req.headers = headers;
  return req;
}

function createMockResponse() {
  const res = new EventEmitter() as EventEmitter & {
    headersSent: boolean;
    statusCode: number;
    headers: Map<string, string>;
    setHeader: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
    end: jest.Mock;
    write: jest.Mock;
  };

  res.headersSent = false;
  res.statusCode = 200;
  res.headers = new Map();
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers.set(name, value);
  });
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn(() => {
    res.headersSent = true;
    return res;
  });
  res.end = jest.fn(() => {
    res.headersSent = true;
    return res;
  });
  res.write = jest.fn();

  return res;
}