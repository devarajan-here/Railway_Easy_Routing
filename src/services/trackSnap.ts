interface RoutePoint {
  lat: number;
  lng: number;
}

interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: 'way';
  id: number;
  nodes?: number[];
}

type OverpassElement = OverpassNode | OverpassWay;

interface GraphNode {
  id: number;
  lat: number;
  lng: number;
}

interface GraphEdge {
  to: number;
  weight: number;
}

const segmentCache = new Map<string, RoutePoint[]>();
const MAX_ROUTE_POINTS = 80;
const MAX_SEGMENT_SPAN_DEGREES = 2.2;

function rounded(value: number) {
  return Number(value.toFixed(4));
}

function cacheKey(a: RoutePoint, b: RoutePoint) {
  return `${rounded(a.lat)},${rounded(a.lng)}:${rounded(b.lat)},${rounded(b.lng)}`;
}

function distanceKm(a: RoutePoint, b: RoutePoint) {
  const earthRadiusKm = 6371;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * Math.PI / 180;
  const deltaLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function segmentBounds(a: RoutePoint, b: RoutePoint) {
  const minLat = Math.min(a.lat, b.lat);
  const maxLat = Math.max(a.lat, b.lat);
  const minLng = Math.min(a.lng, b.lng);
  const maxLng = Math.max(a.lng, b.lng);
  const span = Math.max(maxLat - minLat, maxLng - minLng);
  const pad = Math.min(0.35, Math.max(0.08, span * 0.35));

  return {
    south: minLat - pad,
    west: minLng - pad,
    north: maxLat + pad,
    east: maxLng + pad,
    span
  };
}

async function fetchRailwayGraph(a: RoutePoint, b: RoutePoint) {
  const bounds = segmentBounds(a, b);
  if (bounds.span > MAX_SEGMENT_SPAN_DEGREES) return null;

  const query = `
    [out:json][timeout:18];
    (
      way["railway"~"^(rail|narrow_gauge|light_rail)$"]["service"!~"^(yard|siding|spur)$"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
    );
    (._;>;);
    out body;
  `;

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'RailwayEasyRouting/1.0 (https://devarajan.site)'
    },
    body: new URLSearchParams({ data: query }).toString()
  });

  if (!response.ok) return null;

  const data = await response.json() as { elements?: OverpassElement[] };
  const elements = data.elements || [];
  const nodes = new Map<number, GraphNode>();
  const edges = new Map<number, GraphEdge[]>();

  for (const element of elements) {
    if (element.type !== 'node') continue;
    nodes.set(element.id, {
      id: element.id,
      lat: element.lat,
      lng: element.lon
    });
  }

  const addEdge = (from: GraphNode, to: GraphNode) => {
    const weight = distanceKm(from, to);
    if (!edges.has(from.id)) edges.set(from.id, []);
    edges.get(from.id)!.push({ to: to.id, weight });
  };

  for (const element of elements) {
    if (element.type !== 'way' || !Array.isArray(element.nodes)) continue;

    for (let i = 0; i < element.nodes.length - 1; i++) {
      const from = nodes.get(element.nodes[i]);
      const to = nodes.get(element.nodes[i + 1]);
      if (!from || !to) continue;
      addEdge(from, to);
      addEdge(to, from);
    }
  }

  if (nodes.size === 0 || edges.size === 0) return null;
  return { nodes, edges };
}

function nearestNodeId(point: RoutePoint, nodes: Map<number, GraphNode>) {
  let bestId: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const node of nodes.values()) {
    const candidateDistance = distanceKm(point, node);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestId = node.id;
    }
  }

  return bestDistance <= 15 ? bestId : null;
}

function shortestPath(
  startId: number,
  endId: number,
  edges: Map<number, GraphEdge[]>
) {
  const distances = new Map<number, number>([[startId, 0]]);
  const previous = new Map<number, number>();
  const queue = new Set<number>([startId]);

  while (queue.size > 0) {
    let current: number | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;

    for (const id of queue) {
      const distance = distances.get(id) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        current = id;
        currentDistance = distance;
      }
    }

    if (current === null) break;
    queue.delete(current);
    if (current === endId) break;

    for (const edge of edges.get(current) || []) {
      const nextDistance = currentDistance + edge.weight;
      if (nextDistance >= (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(edge.to, nextDistance);
      previous.set(edge.to, current);
      queue.add(edge.to);
    }
  }

  if (!distances.has(endId)) return [];

  const path = [endId];
  let cursor = endId;
  while (cursor !== startId) {
    const prev = previous.get(cursor);
    if (prev === undefined) return [];
    path.push(prev);
    cursor = prev;
  }

  return path.reverse();
}

async function snapSegmentToRailway(a: RoutePoint, b: RoutePoint) {
  const key = cacheKey(a, b);
  const cached = segmentCache.get(key);
  if (cached) return cached;

  try {
    const graph = await fetchRailwayGraph(a, b);
    if (!graph) return [];

    const startId = nearestNodeId(a, graph.nodes);
    const endId = nearestNodeId(b, graph.nodes);
    if (startId === null || endId === null || startId === endId) return [];

    const nodePath = shortestPath(startId, endId, graph.edges);
    if (nodePath.length < 2) return [];

    const snapped = nodePath
      .map(id => graph.nodes.get(id))
      .filter((node): node is GraphNode => Boolean(node))
      .map(node => ({ lat: node.lat, lng: node.lng }));

    segmentCache.set(key, snapped);
    return snapped;
  } catch (err) {
    console.warn('Railway track snap failed:', err);
    return [];
  }
}

export async function snapRouteToRailway(points: RoutePoint[]) {
  const cleanPoints = points
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .slice(0, MAX_ROUTE_POINTS);

  if (cleanPoints.length < 2) return { snapped: false, points: cleanPoints };

  const snappedPoints: RoutePoint[] = [];
  let snappedSegments = 0;

  for (let i = 0; i < cleanPoints.length - 1; i++) {
    const a = cleanPoints[i];
    const b = cleanPoints[i + 1];
    const snappedSegment = await snapSegmentToRailway(a, b);
    const segment = snappedSegment.length >= 2 ? snappedSegment : [a, b];

    if (snappedSegment.length >= 2) snappedSegments++;
    if (snappedPoints.length > 0) segment.shift();
    snappedPoints.push(...segment);
  }

  return {
    snapped: snappedSegments > 0,
    points: snappedPoints
  };
}
