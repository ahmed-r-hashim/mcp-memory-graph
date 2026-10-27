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