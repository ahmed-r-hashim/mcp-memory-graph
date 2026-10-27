import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Request, Response } from 'express';

interface StreamableHTTPServerTransportOptions {
  sessionIdGenerator: () => string;
  eventStore: Map<string, JSONRPCMessage[]>;
}

export class StreamableHTTPServerTransport implements Transport {
  private sessions: Map<string, Response>;
  private eventStore: Map<string, JSONRPCMessage[]>;
  private pendingResponses: Map<string | number, Response>;
  private pendingResponseTimers: Map<string | number, NodeJS.Timeout>;
  private sessionIdGenerator: () => string;
  private currentSessionId: string | null;
  private debugEnabled: boolean;
  private timeoutWarningMs: number;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: StreamableHTTPServerTransportOptions) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this.eventStore = options.eventStore;
    this.sessions = new Map();
    this.pendingResponses = new Map();
    this.pendingResponseTimers = new Map();
    this.currentSessionId = null;
    this.debugEnabled = process.env.MCP_HTTP_DEBUG === 'true';
    this.timeoutWarningMs = this.getTimeoutWarningMs();
  }

  get sessionId(): string | undefined {
    return this.currentSessionId || undefined;
  }

  async start(): Promise<void> {
    // No-op for HTTP transport
  }

  private getTimeoutWarningMs(): number {
    const rawTimeout = process.env.MCP_HTTP_TIMEOUT_WARNING_MS;
    if (!rawTimeout) {
      return 10000;
    }

    const parsedTimeout = Number.parseInt(rawTimeout, 10);
    return Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10000;
  }

  private logDebug(message: string, details?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }

    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console.error(`[MCP HTTP DEBUG] ${message}${suffix}`);
  }

  private clearPendingResponse(requestId: string | number): void {
    const timer = this.pendingResponseTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.pendingResponseTimers.delete(requestId);
    }

    this.pendingResponses.delete(requestId);
  }

  private trackPendingResponse(requestId: string | number, res: Response, sessionId: string): void {
    this.pendingResponses.set(requestId, res);
    this.logDebug('Tracking pending JSON-RPC response', {
      requestId,
      sessionId,
      pendingCount: this.pendingResponses.size,
      timeoutWarningMs: this.timeoutWarningMs,
    });

    const timer = setTimeout(() => {
      this.logDebug('Pending JSON-RPC response still open', {
        requestId,
        sessionId,
        pendingCount: this.pendingResponses.size,
      });
    }, this.timeoutWarningMs);

    this.pendingResponseTimers.set(requestId, timer);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // If this message is the response to a pending POST request, reply on
    // that request's HTTP response directly instead of via the SSE session.
    const messageId = (message as { id?: string | number }).id;
    if (messageId !== undefined && messageId !== null && this.pendingResponses.has(messageId)) {
      const pendingRes = this.pendingResponses.get(messageId)!;
      this.clearPendingResponse(messageId);
      this.logDebug('Sending JSON-RPC response on pending POST connection', {
        messageId,
        pendingCount: this.pendingResponses.size,
      });
      pendingRes.json(message);
      return;
    }

    if (!this.currentSessionId) {
      this.logDebug('Dropping outbound message because no active session exists', {
        messageId,
      });
      throw new Error('No active session');
    }

    const res = this.sessions.get(this.currentSessionId);
    if (!res) {
      // Store message for later retrieval if session not active
      const events = this.eventStore.get(this.currentSessionId) || [];
      events.push(message);
      this.eventStore.set(this.currentSessionId, events);
      this.logDebug('Buffered outbound event because session stream is not active', {
        sessionId: this.currentSessionId,
        bufferedEvents: events.length,
        messageId,
      });
      return;
    }

    // Send message immediately if session is active
    const event = `data: ${JSON.stringify(message)}\n\n`;
    this.logDebug('Sending outbound event on active session stream', {
      sessionId: this.currentSessionId,
      messageId,
    });
    res.write(event);
  }

  async handleRequest(req: Request, res: Response, body: JSONRPCMessage): Promise<void> {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MCP-Session-ID');
    res.setHeader('Access-Control-Expose-Headers', 'X-MCP-Session-ID');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    // Handle HEAD requests (e.g. Docker healthchecks) without establishing a session
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    // Generate or use existing session ID
    const sessionId = (req.headers['x-mcp-session-id'] as string) || this.sessionIdGenerator();
    this.currentSessionId = sessionId;
    this.logDebug('Handling MCP HTTP request', {
      method: req.method,
      sessionId,
      accept: req.headers.accept || null,
      hasBody: body !== undefined && body !== null,
    });

    // Ensure session ID is set in response headers
    res.setHeader('X-MCP-Session-ID', sessionId);

    // Handle session establishment
    if (req.method === 'GET') {
      const acceptHeader = String(req.headers.accept || '');
      const wantsEventStream = acceptHeader.includes('text/event-stream');

      if (!wantsEventStream) {
        res.status(200).json({
          status: 'ok',
          transport: 'streamable-http',
          endpoint: '/mcp'
        });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send any stored events
      const storedEvents = this.eventStore.get(sessionId) || [];
      this.logDebug('Opening SSE session', {
        sessionId,
        replayEventCount: storedEvents.length,
      });
      for (const event of storedEvents) {
        const eventData = `data: ${JSON.stringify(event)}\n\n`;
        res.write(eventData);
      }
      this.eventStore.delete(sessionId);

      // Store response object for sending future events
      this.sessions.set(sessionId, res);

      // Clean up when client disconnects
      req.on('close', () => {
        if (this.currentSessionId === sessionId) {
          this.currentSessionId = null;
        }
        this.sessions.delete(sessionId);
        this.logDebug('SSE session closed', {
          sessionId,
          remainingSessions: this.sessions.size,
        });
        if (this.onclose) {
          this.onclose();
        }
      });

      return;
    }

    // Handle incoming messages
    if (req.method === 'POST') {
      const requestId = (body as { id?: string | number }).id;
      const isRequest = requestId !== undefined && requestId !== null && (body as { method?: string }).method !== undefined;

      if (isRequest) {
        // Hold the response open until send() delivers the matching JSON-RPC response
        this.trackPendingResponse(requestId, res, sessionId);
        res.on('close', () => {
          if (!this.pendingResponses.has(requestId)) {
            return;
          }

          this.logDebug('POST connection closed before JSON-RPC response completed', {
            requestId,
            sessionId,
          });
          this.clearPendingResponse(requestId);
        });
      }

      this.logDebug('Dispatching inbound JSON-RPC message', {
        sessionId,
        requestId: requestId ?? null,
        isRequest,
        method: (body as { method?: string }).method || null,
      });

      if (this.onmessage) {
        this.onmessage(body);
      }

      if (!isRequest) {
        // Notifications/responses have no reply to wait for
        this.logDebug('Completed non-request POST with 202 response', {
          sessionId,
        });
        res.status(202).end();
      }
      return;
    }

    const error = new Error(`Method ${req.method} not allowed. Supported methods: GET, POST, OPTIONS, HEAD`);
    if (this.onerror) {
      this.onerror(error);
    }
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: error.message
      },
      id: null
    });
  }

  async close(): Promise<void> {
    // Close all active sessions
    for (const [sessionId, res] of this.sessions) {
      res.end();
      this.sessions.delete(sessionId);
    }
    for (const timer of this.pendingResponseTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingResponseTimers.clear();
    this.pendingResponses.clear();
    this.eventStore.clear();
    this.currentSessionId = null;
    if (this.onclose) {
      this.onclose();
    }
  }
}
