import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MemoryGraph } from '../graph/MemoryGraph.js';
import { MermaidGenerator } from '../graph/MermaidGenerator.js';
import { MEMORY_TOOLS, MemoryTools } from './memoryTools.js';
import { ToolName } from '../types/mcp.js';

const sleep = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

describe('MemoryTools handlers', () => {
  let dir: string;
  let graph: MemoryGraph;
  let tools: MemoryTools;

  const call = (name: string, args: any = {}) => tools.handleToolCall({ name: name as ToolName, arguments: args });
  const text = async (name: string, args: any = {}) => (await call(name, args)).content[0].text;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tools-'));
    graph = new MemoryGraph({ storageDir: dir });
    await graph.initialize();
    tools = new MemoryTools(graph);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exposes a definition for every handled tool', () => {
    expect(Object.keys(MEMORY_TOOLS).sort()).toEqual([
      'create_domain', 'edit_memory', 'forget_memory', 'generate_mermaid_graph', 'list_domains',
      'recall_memories', 'search_memory_content', 'select_domain', 'store_memory', 'traverse_memories',
    ]);
  });

  it('rejects unknown tools', async () => {
    await expect(call('nope')).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  describe('domains', () => {
    it('creates, lists and selects domains', async () => {
      const created = JSON.parse(await text('create_domain', { id: 'work', name: 'Work', description: 'w' }));
      expect(created.id).toBe('work');

      const listed = JSON.parse(await text('list_domains'));
      expect(listed.currentDomain).toBe('general');
      expect(listed.domains.map((d: any) => d.id).sort()).toEqual(['general', 'work']);

      const selected = JSON.parse(await text('select_domain', { id: 'work' }));
      expect(selected.id).toBe('work');
      expect(graph.getCurrentDomain()).toBe('work');
    });

    it('maps failures to MCP errors', async () => {
      await expect(call('select_domain', { id: 'ghost' }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(call('create_domain', { id: 'general', name: 'x', description: 'x' }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });

      jest.spyOn(graph, 'listDomains').mockRejectedValueOnce(new Error('boom'));
      await expect(call('list_domains')).rejects.toMatchObject({ code: ErrorCode.InternalError });
    });
  });

  describe('memory operations', () => {
    it('wraps failures from store, recall, forget and edit', async () => {
      jest.spyOn(graph, 'storeMemory').mockRejectedValueOnce(new Error('boom'));
      await expect(call('store_memory', { content: 'x' })).rejects.toThrow('Failed to store memory');

      jest.spyOn(graph, 'recallMemories').mockRejectedValueOnce(new Error('boom'));
      await expect(call('recall_memories', { maxNodes: 1, strategy: 'recent' })).rejects.toThrow('Failed to recall memories');

      await expect(call('forget_memory', { id: 'ghost' })).rejects.toThrow('Failed to forget memory');

      jest.spyOn(graph, 'editMemory').mockRejectedValueOnce(new Error('boom'));
      await expect(call('edit_memory', { id: 'x' })).rejects.toThrow('Failed to edit memory');
    });

    it('returns a tool error result for unknown memories on edit', async () => {
      const result = await call('edit_memory', { id: 'ghost', content: 'x' });
      expect(result.isError).toBe(true);
    });
  });

  describe('generate_mermaid_graph', () => {
    it('returns the diagram', async () => {
      const a = JSON.parse(await text('store_memory', { content: 'A node' }));
      const diagram = await text('generate_mermaid_graph', { startNodeId: a.id });
      expect(diagram).toContain('graph LR');
    });

    it('wraps generator failures', async () => {
      jest.spyOn(MermaidGenerator.prototype, 'generateGraph').mockRejectedValueOnce(new Error('boom'));
      await expect(call('generate_mermaid_graph', { startNodeId: 'x' }))
        .rejects.toThrow('Failed to generate Mermaid graph');
    });
  });

  describe('search_memory_content', () => {
    it('reports when nothing matches', async () => {
      const output = await text('search_memory_content', { query: 'zebra' });
      expect(output).toContain('# Search Results for "zebra"');
      expect(output).toContain('No matching memories found.');
    });

    it('formats matches with metadata and connections', async () => {
      const target = await graph.storeMemory({ content: 'target note' });
      const hit = await graph.storeMemory({
        content: 'zebra crossing',
        path: '/animals',
        tags: ['stripes', 'road'],
        summary: 'about zebras',
        relationships: { relates_to: [{ targetId: target.id, strength: 0.75 }] },
      });
      await graph.storeMemory({
        content: 'zebra herd',
        relationships: { supports: [{ targetId: hit.id, strength: 0.5 }] },
      });
      await sleep();
      await graph.editMemory({ id: hit.id, summary: 'updated summary' });

      const output = await text('search_memory_content', { query: 'crossing', domain: 'general', maxResults: 5 });
      expect(output).toContain('Found 1 matching memories:');
      expect(output).toContain(`## Memory 1: ${hit.id}`);
      expect(output).toContain('**Summary:** updated summary');
      expect(output).toContain('*Summary updated:');
      expect(output).toContain('*Path: /animals*');
      expect(output).toContain('*Tags: stripes, road*');
      expect(output).toContain(`- To ${target.id}: relates_to (strength: 0.75)`);

      const incoming = await text('search_memory_content', { query: 'zebra' });
      expect(incoming).toMatch(/- From .*: supports \(strength: 0.50\)/);
    });

    it('omits optional metadata when absent', async () => {
      await graph.storeMemory({ content: 'plain zebra' });
      const output = await text('search_memory_content', { query: 'plain' });
      expect(output).not.toContain('*Tags:');
      expect(output).not.toContain('### Connections');
      expect(output).not.toContain('**Summary:**');
    });

    it('wraps failures', async () => {
      jest.spyOn(graph, 'searchContent').mockRejectedValueOnce(new Error('boom'));
      await expect(call('search_memory_content', { query: 'x' })).rejects.toThrow('Failed to search memory content');
    });
  });

  describe('traverse_memories', () => {
    let a: any, b: any, c: any, w1: any, blank: any;

    beforeEach(async () => {
      await graph.createDomain('work', 'Work', 'w');
      await graph.selectDomain('work');
      w1 = await graph.storeMemory({ content: 'Work node here' });
      await graph.selectDomain('general');

      a = await graph.storeMemory({
        content: 'Alpha note. Extra detail',
        path: '/notes',
        tags: ['t1'],
        summary: 'alpha summary',
        keyEntities: ['AlphaConcept'],
      });
      await sleep();
      await graph.editMemory({ id: a.id, summary: 'alpha summary v2' });
      b = await graph.storeMemory({
        content: 'Bravo note',
        keyEntities: [],
        relationships: { relates_to: [{ targetId: a.id, strength: 0.8 }] },
        domainRefs: [{ domain: 'work', nodeId: w1.id, description: 'to work' }],
      });
      c = await graph.storeMemory({
        content: 'Charlie note',
        relationships: { supports: [{ targetId: b.id, strength: 0.6 }] },
      });
      blank = await graph.storeMemory({
        content: '',
        relationships: { relates_to: [{ targetId: c.id, strength: 0.3 }] },
      });
    });

    it('renders minimal output with IDs only', async () => {
      const output = await text('traverse_memories', { startNodeId: c.id, maxDepth: 3, resolutionDepth: 'minimal' });
      expect(output).toContain('# Memory Graph Traversal');
      expect(output).toContain('- Resolution Depth: minimal');
      expect(output).toContain(`*ID: ${c.id}*`);
      expect(output).toContain(`from Memory ${blank.id}`);
      expect(output).toContain(`to Memory ${b.id}`);
      expect(output).not.toContain('*Created:');
    });

    it('renders standard output (default) with content, summaries and connection details', async () => {
      const output = await text('traverse_memories', { startNodeId: c.id, maxDepth: 3 });
      expect(output).toContain('- Resolution Depth: standard');
      expect(output).toContain('- Domains Visited: general, work');
      expect(output).toContain('## Domain: general');
      expect(output).toContain('## Domain: work');
      expect(output).toContain('Alpha note. Extra detail');
      expect(output).toContain('**Summary:** alpha summary v2');
      expect(output).toContain('*Summary updated:');
      expect(output).toContain('#### Incoming Connections');
      expect(output).toContain('#### Outgoing Connections');
      expect(output).toContain('**supports** (strength: 0.60) to "Bravo note"');
      expect(output).toContain('*"Bravo note"*');
      expect(output).toContain(`### Memory ${blank.id}`);
    });

    it('renders detailed output with metadata but without quoted connection bodies', async () => {
      const output = await text('traverse_memories', { startNodeId: b.id, maxDepth: 2, resolutionDepth: 'detailed' });
      expect(output).toContain('*Path: /notes*');
      expect(output).toContain('*Tags: t1*');
      expect(output).toContain('*Key concepts: AlphaConcept*');
      expect(output).toContain('**relates_to** (strength: 0.80) to "Alpha note"');
      expect(output).not.toContain('*"Alpha note. Extra detail"*');
    });

    it('renders comprehensive output with connection IDs', async () => {
      const output = await text('traverse_memories', { startNodeId: b.id, maxDepth: 2, resolutionDepth: 'comprehensive' });
      expect(output).toContain(`to "Alpha note" [${a.id}]`);
      expect(output).toContain(`from "Charlie note" [${c.id}]`);
      expect(output).toContain('*"Charlie note"*');
    });

    it('lists cross-domain connections in both directions', async () => {
      const output = await text('traverse_memories', { startNodeId: b.id, maxDepth: 2, resolutionDepth: 'detailed' });
      expect(output).toContain('#### Cross-Domain Connections');
      expect(output).toContain(`**→ Points to** domain "work" (memory ${w1.id}): to work`);
      expect(output).toContain(`**← Referenced from** domain "general" (memory ${b.id}): to work`);
    });

    it('omits descriptions on cross-domain connections that have none', async () => {
      const plain = await graph.storeMemory({
        content: 'Plain pointer',
        domainRefs: [{ domain: 'work', nodeId: w1.id }],
      });
      const output = await text('traverse_memories', { startNodeId: plain.id, maxDepth: 2, resolutionDepth: 'minimal' });
      expect(output).toMatch(/\*\*→ Points to\*\* domain "work" \(memory [^)]+\)\n/);
      expect(output).toMatch(/\*\*← Referenced from\*\* domain "general" \(memory [^)]+\)\n/);
    });

    it('wraps failures', async () => {
      await expect(call('traverse_memories', { startNodeId: 'ghost' })).rejects.toThrow('Failed to traverse memories');
    });
  });
});
