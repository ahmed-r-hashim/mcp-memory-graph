#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'crypto';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryGraph } from './graph/MemoryGraph.js';
import { MEMORY_TOOLS, MemoryTools } from './tools/memoryTools.js';
import { MemoryResources } from './resources/memoryResources.js';
import { StoreMemoryInput, RecallMemoriesInput, ForgetMemoryInput } from './types/graph.js';
import { ToolName, ToolRequest, ToolResponse } from './types/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface MemoryGraphServerConfig {
  strictMode?: boolean;
  transportType?: 'STDIO' | 'HTTP';
  port?: number;
  host?: string;
}

class MemoryGraphServer {
  private memoryGraph: MemoryGraph;
  private memoryTools: MemoryTools;
  private memoryResources: MemoryResources;
  private config: MemoryGraphServerConfig;
  private stdioServer?: Server;
  private httpSessions: Map<string, { server: Server; transport: StreamableHTTPServerTransport }>;
  private httpDebugEnabled: boolean;

  constructor(config: MemoryGraphServerConfig = {}) {
    this.config = config;
    this.httpSessions = new Map();
    this.httpDebugEnabled = process.env.MCP_HTTP_DEBUG === 'true';
    
    // Initialize memory graph
    const storageDir = process.env.MEMORY_DIR || path.join(__dirname, '../data');
    const storageType = process.env.STORAGE_TYPE || 'json';
    
    // In strict mode, all informational logging goes to stderr
    if (this.config.strictMode) {
      console.error(`STORAGE_TYPE: ${storageType}`);
    } else {
      console.log(`STORAGE_TYPE: ${storageType}`);
    }

    // Configure MariaDB options if needed
    const dbConfig = storageType.toLowerCase() === 'mariadb' ? {
      host: process.env.MARIADB_HOST || 'localhost',
      user: process.env.MARIADB_USER || 'root',
      password: process.env.MARIADB_PASSWORD || '',
      database: process.env.MARIADB_DATABASE || 'memory_graph',
      port: process.env.MARIADB_PORT ? parseInt(process.env.MARIADB_PORT, 10) : 3306,
      waitForConnections: true,
      connectionLimit: process.env.MARIADB_CONNECTION_LIMIT ? 
        parseInt(process.env.MARIADB_CONNECTION_LIMIT, 10) : 10,
      queueLimit: 0
    } : undefined;

    this.memoryGraph = new MemoryGraph({
      storageDir,
      defaultPath: process.env.DEFAULT_PATH || '/',
      storageType: storageType,
      dbConfig
    });
    this.memoryTools = new MemoryTools(this.memoryGraph);
    this.memoryResources = new MemoryResources(this.memoryGraph);

    process.on('SIGINT', async () => {
      await this.close();
      process.exit(0);
    });
  }

  private logHttpDebug(message: string, details?: Record<string, unknown>) {
    if (!this.httpDebugEnabled) {
      return;
    }

    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console.error(`[MCP HTTP DEBUG] ${message}${suffix}`);
  }

  private createServer() {
    const server = new Server(
      {
        name: 'memory-graph',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.values(MEMORY_TOOLS),
    }));

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const toolRequest: ToolRequest = {
          name: request.params.name as ToolName,
          arguments: (request.params.arguments || {}) as unknown as StoreMemoryInput | RecallMemoriesInput | ForgetMemoryInput,
        };

        const response = await this.memoryTools.handleToolCall(toolRequest);
        return response as unknown as ServerResult;
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to handle tool call: ${error}`
        );
      }
    });

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'memory://domains/statistics',
          name: 'Domain Statistics',
          description: 'Statistics about memory domains',
          mimeType: 'application/json',
        },
        {
          uri: 'memory://edges/filter-terms',
          name: 'Memory Edge Filter Terms',
          description: 'Available relationship types for filtering memory edges',
          mimeType: 'application/json',
        },
        {
          uri: 'memory://tags/popular',
          name: 'Popular Memory Tags',
          description: 'Most frequently used memory tags (top 10%)',
          mimeType: 'application/json',
        },
        {
          uri: 'essential_priority://domains',
          name: 'Essential Domain Memories',
          description: 'Top-level memories that provide essential context for each domain',
          mimeType: 'application/json',
        },
      ],
    }));

    // List resource templates
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [],
    }));

    // Read resource contents
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        const uri = request.params.uri;
        let content: string;

        if (uri === 'memory://domains/statistics') {
          const data = await this.memoryResources.getDomainStatistics();
          content = JSON.stringify(data, null, 2);
        } else if (uri === 'memory://edges/filter-terms') {
          const data = await this.memoryResources.getEdgeFilterTerms();
          content = JSON.stringify(data, null, 2);
        } else if (uri === 'memory://tags/popular') {
          const data = await this.memoryResources.getPopularTags();
          content = JSON.stringify(data, null, 2);
        } else if (uri === 'essential_priority://domains') {
          const data = await this.memoryResources.getEssentialPriorityMemories();
          content = JSON.stringify(data, null, 2);
        } else {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Unknown resource URI: ${uri}`
          );
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: content,
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read resource: ${error}`
        );
      }
    });

    // Error handling
    server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    return server;
  }

  private async close() {
    if (this.stdioServer) {
      await this.stdioServer.close();
      this.stdioServer = undefined;
    }

    for (const [sessionId, session] of this.httpSessions) {
      this.logHttpDebug('Closing HTTP session during shutdown', { sessionId });
      await session.transport.close();
      await session.server.close();
    }
    this.httpSessions.clear();
  }

  private async startHttpTransport() {
    if (!this.config.port) {
      throw new Error('PORT environment variable is required for HTTP transport');
    }

    const port = this.config.port;
    const host = this.config.host || '127.0.0.1';
    const app = express();
    app.use(express.json());

    app.post('/mcp', async (req, res) => {
      try {
        const sessionIdHeader = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
        let session = sessionId ? this.httpSessions.get(sessionId) : undefined;

        if (session) {
          this.logHttpDebug('Routing POST to existing HTTP session', {
            sessionId,
            method: (req.body as { method?: string } | undefined)?.method ?? null,
          });
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          const server = this.createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              this.httpSessions.set(newSessionId, { server, transport });
              this.logHttpDebug('Registered new HTTP session', {
                sessionId: newSessionId,
                activeSessions: this.httpSessions.size,
              });
            },
            onsessionclosed: (closedSessionId) => {
              this.httpSessions.delete(closedSessionId);
              this.logHttpDebug('Session closed by client', {
                sessionId: closedSessionId,
                activeSessions: this.httpSessions.size,
              });
            },
          });

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        this.logHttpDebug('Rejected POST without a valid HTTP session', {
          sessionId: sessionId ?? null,
          method: (req.body as { method?: string } | undefined)?.method ?? null,
        });

        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    app.get('/mcp', async (req, res) => {
      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (!sessionId) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const session = this.httpSessions.get(sessionId);
      if (!session) {
        res.status(404).send('Session not found');
        return;
      }

      this.logHttpDebug('Routing GET to existing HTTP session', {
        sessionId,
        lastEventId: req.headers['last-event-id'] ?? null,
      });

      try {
        await session.transport.handleRequest(req, res);
      } catch (error) {
        console.error('Error handling MCP SSE request:', error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    });

    app.delete('/mcp', async (req, res) => {
      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (!sessionId) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const session = this.httpSessions.get(sessionId);
      if (!session) {
        res.status(404).send('Session not found');
        return;
      }

      this.logHttpDebug('Routing DELETE to existing HTTP session', {
        sessionId,
      });

      try {
        await session.transport.handleRequest(req, res);
        await session.server.close();
        this.httpSessions.delete(sessionId);
      } catch (error) {
        console.error('Error handling MCP session termination:', error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    });

    const server = app.listen(port, host, () => {
      console.error(`Memory Graph MCP server running on http://${host}:${port}/mcp`);
    });

    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use`);
      } else {
        console.error('HTTP server error:', error);
      }
      process.exit(1);
    });
  }

  private async startStdioTransport() {
    const server = this.createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.stdioServer = server;
    console.error('Memory Graph MCP server running on stdio');
  }

  async start() {
    try {
      // Initialize memory graph
      await this.memoryGraph.initialize();

      // Initialize transport based on configuration
      const transportType = this.config.transportType || 'STDIO';
      
      // Explicitly separate transport initialization
      if (transportType === 'HTTP') {
        await this.startHttpTransport();
      } else if (transportType === 'STDIO') {
        await this.startStdioTransport();
      } else {
        throw new Error(`Invalid transport type: ${transportType}`);
      }
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Start server
const strictMode = process.env.STRICT_MODE === 'true';
const transportType = (process.env.TRANSPORT_TYPE || 'STDIO').toUpperCase();
const port = process.env.PORT ? parseInt(process.env.PORT) : undefined;
const host = process.env.HOST || '127.0.0.1';

// Validate transport type
if (transportType !== 'STDIO' && transportType !== 'HTTP') {
  console.error(`Invalid TRANSPORT_TYPE: ${transportType}. Must be either 'STDIO' or 'HTTP'`);
  process.exit(1);
}

const server = new MemoryGraphServer({ 
  strictMode,
  transportType: transportType as 'STDIO' | 'HTTP',
  port,
  host
});
server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
