import { RelationshipManager } from './RelationshipManager.js';
import { RelationshipType, RelationshipUtils, RELATIONSHIP_TYPES } from '../types/relationships.js';
import { GraphEdge } from '../types/graph.js';

describe('RelationshipUtils', () => {
  it('returns type info', () => {
    expect(RelationshipUtils.getTypeInfo(RelationshipType.FOLLOWS)).toBe(RELATIONSHIP_TYPES[RelationshipType.FOLLOWS]);
  });

  it('validates type strings', () => {
    expect(RelationshipUtils.isValidType('supports')).toBe(true);
    expect(RelationshipUtils.isValidType('nope')).toBe(false);
  });

  it('returns inverse types or null', () => {
    expect(RelationshipUtils.getInverseType(RelationshipType.CONTAINS)).toBe(RelationshipType.PART_OF);
    expect(RelationshipUtils.getInverseType(RelationshipType.SUPPORTS)).toBeNull();
  });

  it('computes a weighted composite strength', () => {
    const composite = RelationshipUtils.calculateCompositeStrength({
      overall: 1, semantic: 1, temporal: 1, confidence: 1, usage: 1,
    });
    expect(composite).toBeCloseTo(1);
    expect(RelationshipUtils.calculateCompositeStrength({
      overall: 1, semantic: 0, temporal: 0, confidence: 0, usage: 0,
    })).toBeCloseTo(0.3);
  });

  it('creates basic strength with defaults', () => {
    expect(RelationshipUtils.createBasicStrength(0.4)).toEqual({
      overall: 0.4, semantic: 0.4, temporal: 0.5, confidence: 0.8, usage: 0.5,
    });
  });

  it('creates relationships from numeric strength and options', () => {
    const rel = RelationshipUtils.createRelationship('t', RelationshipType.SIMILAR_TO, 0.6, {
      isInferred: true, evidence: ['e'], tags: ['x'],
    });
    expect(rel).toMatchObject({
      targetId: 't',
      type: RelationshipType.SIMILAR_TO,
      isBidirectional: true,
      isTransitive: false,
      isInferred: true,
      evidence: ['e'],
      tags: ['x'],
    });
    expect(rel.strength.overall).toBe(0.6);
  });

  it('creates relationships from explicit strength with default options', () => {
    const strength = { overall: 1, semantic: 1, temporal: 1, confidence: 1, usage: 1 };
    const rel = RelationshipUtils.createRelationship('t', RelationshipType.SUPPORTS, strength);
    expect(rel.strength).toBe(strength);
    expect(rel.isInferred).toBe(false);
    expect(rel.isTransitive).toBe(true);
  });

  it('lists inferable types (transitive or with an inverse)', () => {
    const inferable = RelationshipUtils.getInferableTypes();
    expect(inferable).toContain(RelationshipType.SUPPORTS);
    expect(inferable).toContain(RelationshipType.REFERENCES);
    expect(inferable).not.toContain(RelationshipType.RELATES_TO);
  });

  it('sorts types by semantic weight descending', () => {
    const sorted = RelationshipUtils.getTypesBySemanticWeight();
    const weights = sorted.map(t => RELATIONSHIP_TYPES[t].semanticWeight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });
});

describe('RelationshipManager', () => {
  const edge = (over: Partial<GraphEdge> = {}): GraphEdge => ({
    source: 'a', target: 'b', type: 'relates_to', strength: 0.5, timestamp: 't', ...over,
  });

  it('starts empty', () => {
    const manager = new RelationshipManager();
    expect(manager.getAllEdges()).toEqual([]);
    expect(manager.getStatistics()).toEqual({
      totalRelationships: 0,
      inferredRelationships: 0,
      relationshipTypeDistribution: {},
      averageStrength: 0,
    });
  });

  it('loads existing edges without creating inverses', () => {
    const manager = new RelationshipManager([edge({ type: 'follows' })]);
    expect(manager.getAllEdges()).toHaveLength(1);
  });

  it('adds a relationship with an inverse when the type has one', () => {
    const manager = new RelationshipManager();
    const added = manager.addRelationship('a', 'b', RelationshipType.FOLLOWS, 0.8, {
      evidence: ['because'], tags: ['x'],
    });

    expect(added.strength).toBe(0.8);
    expect(added.relationship?.evidence).toEqual(['because']);

    const all = manager.getAllEdges();
    expect(all).toHaveLength(2);
    const inverse = all.find(e => e.type === RelationshipType.PRECEDES)!;
    expect(inverse).toMatchObject({ source: 'b', target: 'a', strength: 0.8 });
    expect(inverse.relationship?.isInferred).toBe(true);
  });

  it('does not create a duplicate inverse', () => {
    const manager = new RelationshipManager();
    manager.addRelationship('a', 'b', RelationshipType.FOLLOWS, 0.8);
    manager.addRelationship('a', 'b', RelationshipType.FOLLOWS, 0.9);
    expect(manager.getEdgesBetween('b', 'a').filter(e => e.type === RelationshipType.PRECEDES)).toHaveLength(1);
  });

  it('adds a relationship without an inverse and with multi-dimensional strength', () => {
    const manager = new RelationshipManager();
    const added = manager.addRelationship('a', 'b', RelationshipType.SUPPORTS, {
      overall: 1, semantic: 1, temporal: 1, confidence: 1, usage: 1,
    });
    expect(added.strength).toBeCloseTo(1);
    expect(manager.getAllEdges()).toHaveLength(1);
  });

  it('removes a relationship together with its inferred inverse', () => {
    const manager = new RelationshipManager();
    manager.addRelationship('a', 'b', RelationshipType.CONTAINS, 0.5);

    expect(manager.removeRelationship('a', 'b', RelationshipType.CONTAINS)).toBe(true);
    expect(manager.getAllEdges()).toEqual([]);
  });

  it('returns false when removing a non-existent relationship', () => {
    const manager = new RelationshipManager();
    expect(manager.removeRelationship('x', 'y', RelationshipType.SUPPORTS)).toBe(false);
  });

  it('keeps unrelated edges when removing', () => {
    const manager = new RelationshipManager();
    manager.addRelationship('a', 'b', RelationshipType.SUPPORTS, 0.5);
    manager.addRelationship('a', 'c', RelationshipType.SUPPORTS, 0.5);
    manager.removeRelationship('a', 'b', RelationshipType.SUPPORTS);
    expect(manager.getNodeEdges('a')).toHaveLength(1);
  });

  it('returns edges per node and between nodes', () => {
    const manager = new RelationshipManager([edge(), edge({ source: 'b', target: 'c' })]);
    expect(manager.getNodeEdges('b')).toHaveLength(2);
    expect(manager.getNodeEdges('zzz')).toEqual([]);
    expect(manager.getEdgesBetween('a', 'b')).toHaveLength(1);
    expect(manager.getEdgesBetween('zzz', 'b')).toEqual([]);
  });

  it('maps legacy and unknown edge types', () => {
    const manager = new RelationshipManager([
      edge({ type: 'SUPPORTS' }),
      edge({ source: 'c', target: 'd', type: 'totally_custom' }),
      edge({
        source: 'e', target: 'f', type: 'ignored',
        relationship: { type: 'Refines' } as any,
      }),
      edge({
        source: 'g', target: 'h', type: 'ignored',
        relationship: { type: 'causes' } as any,
      }),
    ]);
    const dist = manager.getStatistics().relationshipTypeDistribution;
    expect(dist[RelationshipType.SUPPORTS]).toBe(1);
    expect(dist[RelationshipType.RELATES_TO]).toBe(1);
    expect(dist[RelationshipType.REFINES]).toBe(1);
    expect(dist[RelationshipType.CAUSES]).toBe(1);
  });

  it('deduplicates edges indexed under source and target', () => {
    const manager = new RelationshipManager([edge()]);
    expect(manager.getAllEdges()).toHaveLength(1);
  });

  it('computes statistics', () => {
    const manager = new RelationshipManager();
    manager.addRelationship('a', 'b', RelationshipType.FOLLOWS, 0.6);
    manager.addRelationship('a', 'c', RelationshipType.SUPPORTS, 0.2);

    const stats = manager.getStatistics();
    expect(stats.totalRelationships).toBe(3);
    expect(stats.inferredRelationships).toBe(1);
    expect(stats.relationshipTypeDistribution).toEqual({
      [RelationshipType.FOLLOWS]: 1,
      [RelationshipType.PRECEDES]: 1,
      [RelationshipType.SUPPORTS]: 1,
    });
    expect(stats.averageStrength).toBeCloseTo((0.6 + 0.6 + 0.2) / 3);
  });
});
