import db from '../db';
import { findRoutes } from './routing';
import { fetchOnlineDirectRoutes, OnlineItinerary } from './onlineTrains';

interface StationPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface RouteSuggestion {
  hub: StationPoint;
  distance_from_source_km: number;
  access_note: string;
  access_options: OnlineItinerary[];
  onward_options: OnlineItinerary[];
  total_duration_minutes: number | null;
}

const preferredHubIds = [
  'TCR', 'ERS', 'CBE', 'PGT', 'SA', 'SBC', 'YPR', 'MYS', 'MAS', 'MS', 'MAQ', 'MAJN',
  'TVC', 'MDU', 'TPJ', 'ED', 'KJM', 'BNC', 'NDLS', 'ADI', 'BCT', 'LTT', 'CSMT', 'HWH',
  'PUNE', 'KYN', 'PNVL', 'TN', 'TME', 'KLPM'
];

function isInterchange(station: StationPoint) {
  return preferredHubIds.includes(station.id)
    || /\b(JN|JUNCTION|CENTRAL|CANTT|CITY|TERMINUS|TERMINAL)\b/i.test(station.name)
    || station.id.length <= 3;
}

function distanceKm(a: StationPoint, b: StationPoint) {
  const earthRadiusKm = 6371;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * Math.PI / 180;
  const deltaLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function getStation(id: string) {
  return db.prepare(`
    SELECT id, name, latitude as lat, longitude as lng
    FROM stations
    WHERE id = ?
  `).get(id) as StationPoint | undefined;
}

function getCandidateHubs(source: StationPoint, destinationId: string) {
  const rows = db.prepare(`
    SELECT id, name, latitude as lat, longitude as lng
    FROM stations
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `).all() as StationPoint[];

  const scored = rows
    .filter(station => station.id !== source.id && station.id !== destinationId && isInterchange(station))
    .map(station => ({
      station,
      distance: distanceKm(source, station),
      preferred: preferredHubIds.includes(station.id) ? 0 : 1,
      nearby: 0
    }))
    .filter(item => item.distance <= 260 || item.preferred === 0)
    .map(item => ({
      ...item,
      nearby: item.distance <= 80 ? 0 : 1
    }))
    .sort((a, b) => a.nearby - b.nearby || a.distance - b.distance || a.preferred - b.preferred)
    .slice(0, 40);

  const seen = new Set<string>();
  return scored
    .filter(item => {
      if (seen.has(item.station.id)) return false;
      seen.add(item.station.id);
      return true;
    })
    .map(item => ({ ...item.station, distance_from_source_km: item.distance }));
}

function mergeRoutes(onlineRoutes: OnlineItinerary[], localRoutes: OnlineItinerary[]) {
  const seen = new Set<string>();
  return [...onlineRoutes, ...localRoutes].filter(route => {
    const key = route.segments.map(segment => segment.train_id).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function findRouteSuggestions(sourceId: string, destinationId: string, requestedDate: Date) {
  const source = getStation(sourceId);
  if (!source) return [];

  const suggestions: RouteSuggestion[] = [];
  const hubs = getCandidateHubs(source, destinationId);

  for (const hub of hubs) {
    let onwardOnline: OnlineItinerary[] = [];
    let accessOnline: OnlineItinerary[] = [];

    try {
      onwardOnline = await fetchOnlineDirectRoutes(hub.id, destinationId, requestedDate);
    } catch {
      onwardOnline = [];
    }

    const onwardOptions = mergeRoutes(onwardOnline, findRoutes(hub.id, destinationId, requestedDate)).slice(0, 3);
    if (onwardOptions.length === 0) continue;

    try {
      accessOnline = await fetchOnlineDirectRoutes(sourceId, hub.id, requestedDate);
    } catch {
      accessOnline = [];
    }

    const accessOptions = mergeRoutes(accessOnline, findRoutes(sourceId, hub.id, requestedDate)).slice(0, 2);
    const bestAccess = accessOptions[0];
    const bestOnward = onwardOptions[0];

    suggestions.push({
      hub: {
        id: hub.id,
        name: hub.name,
        lat: hub.lat,
        lng: hub.lng
      },
      distance_from_source_km: Math.round(hub.distance_from_source_km),
      access_note: bestAccess
        ? `First take ${bestAccess.segments[0].train_name} to ${hub.name}.`
        : `No confirmed online train found from ${source.name} to ${hub.name}; use a local train, road link, or search this short leg separately.`,
      access_options: accessOptions,
      onward_options: onwardOptions,
      total_duration_minutes: bestAccess
        ? bestAccess.total_duration_minutes + bestOnward.total_duration_minutes
        : null
    });

    const confirmedSuggestions = suggestions.filter(suggestion => suggestion.total_duration_minutes !== null);
    if (confirmedSuggestions.length >= 10 || suggestions.length >= 18) break;
  }

  return suggestions
    .sort((a, b) => {
      const aTime = a.total_duration_minutes ?? Number.POSITIVE_INFINITY;
      const bTime = b.total_duration_minutes ?? Number.POSITIVE_INFINITY;
      if (aTime !== bTime) return aTime - bTime;

      const aOnward = a.onward_options[0]?.total_duration_minutes ?? Number.POSITIVE_INFINITY;
      const bOnward = b.onward_options[0]?.total_duration_minutes ?? Number.POSITIVE_INFINITY;
      if (aOnward !== bOnward) return aOnward - bOnward;

      return a.distance_from_source_km - b.distance_from_source_km;
    })
    .slice(0, 4);
}
