import db from '../db.ts';

interface OnlineTrainRow {
  num: string;
  name: string;
  s: string;
  st: string;
  d: string;
  dt: string;
  tt: string;
  dy?: string;
}

interface OnlineScheduleStop {
  station_id: string;
  station_name: string;
  latitude: number;
  longitude: number;
  arrival_time: string | null;
  departure_time: string | null;
  stop_sequence: number;
  day_offset: number;
}

interface RouteSegment {
  train_id: string;
  train_name: string;
  from_station_id: string;
  from_station_name: string;
  to_station_id: string;
  to_station_name: string;
  departure_time: string;
  arrival_time: string;
  departure_day_offset: number;
  arrival_day_offset: number;
  duration_minutes: number;
  service_date: string;
  route_points?: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
  }>;
}

export interface OnlineItinerary {
  segments: RouteSegment[];
  total_transfers: number;
  total_duration_minutes: number;
  final_arrival_day_offset: number;
  source?: string;
}

type OnlineScheduleResult = Awaited<ReturnType<typeof buildOnlineTrainSchedule>>;
const onlineScheduleCache = new Map<string, { expiresAt: number; value: OnlineScheduleResult }>();
const ONLINE_SCHEDULE_CACHE_MS = 12 * 60 * 60 * 1000;

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function durationToMinutes(value: string) {
  const match = value.match(/(?:(\d+):(\d+)|(?:(\d+)H)?\s*(?:(\d+)M)?)/i);
  if (!match) return 0;

  if (match[1] && match[2]) {
    return Number(match[1]) * 60 + Number(match[2]);
  }

  return Number(match[3] || 0) * 60 + Number(match[4] || 0);
}

function stationName(code: string) {
  const row = db.prepare('SELECT name FROM stations WHERE id = ?').get(code) as { name: string } | undefined;
  return row?.name || STATION_ALIASES[code]?.name || code;
}

const STATION_ALIASES: Record<string, { name: string; lat: number; lng: number }> = {
  SMVB: { name: 'SMVT BENGALURU', lat: 13.005, lng: 77.686 },
  CSMT: { name: 'MUMBAI CSMT', lat: 18.944481, lng: 72.836903 },
  MMCT: { name: 'MUMBAI CENTRAL', lat: 18.970667, lng: 72.819383 },
};

const ONLINE_DESTINATION_ALIASES: Record<string, string[]> = {
  BCT: ['BCT', 'MMCT', 'LTT', 'DR', 'CSTM', 'CSMT', 'BDTS', 'KYN', 'PNVL', 'BSR'],
  CSTM: ['CSTM', 'CSMT', 'DR', 'LTT', 'KYN', 'PNVL'],
  TNA: ['TNA', 'PNVL', 'LTT', 'CSTM', 'CSMT', 'DR', 'KYN']
};

function stationPoint(code: string) {
  const row = db.prepare('SELECT id, name, latitude as lat, longitude as lng FROM stations WHERE id = ?').get(code) as
    | { id: string; name: string; lat: number; lng: number }
    | undefined;

  if (row) return row;
  const alias = STATION_ALIASES[code];
  return alias ? { id: code, ...alias } : null;
}

function scheduleRoutePoints(
  schedule: OnlineScheduleStop[],
  sourceId: string,
  destinationId: string
) {
  const sourceIndex = schedule.findIndex(stop => stop.station_id === sourceId);
  const destinationIndex = schedule.findIndex(stop => stop.station_id === destinationId);

  if (sourceIndex === -1 || destinationIndex === -1 || sourceIndex >= destinationIndex) {
    return [];
  }

  return schedule.slice(sourceIndex, destinationIndex + 1).map(stop => ({
    id: stop.station_id,
    name: stop.station_name,
    lat: stop.latitude,
    lng: stop.longitude
  }));
}

function slugifyTrainName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join('-');
}

function parseScheduleTime(value: string) {
  if (/source/i.test(value) || /destination/i.test(value)) return null;
  const match = value.match(/(\d{2}:\d{2})\s*\(Day\s*(\d+)\)/i);
  if (!match) return null;

  return {
    time: match[1],
    dayOffset: Math.max(0, Number(match[2]) - 1)
  };
}

function parseScheduleRows(html: string): OnlineScheduleStop[] {
  const rows: OnlineScheduleStop[] = [];
  const rowRegex = /<td class="txt-center pdud15 dborder nobr"><div class="pdl5">(\d+)<\/div><small><div class="pdl5">([^<]+)<\/div><\/small><\/td>[\s\S]*?<div class="fixwelps">([^<]+)<\/div>[\s\S]*?<td class="txt-lt dborder"><div class="nowrap pd5">([^<]+)<\/div><div class="nowrap pd5">([^<]+)<\/div><\/td>/g;
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(html))) {
    const code = match[2].trim();
    const point = stationPoint(code);
    if (!point) continue;

    const arrival = parseScheduleTime(match[4]);
    const departure = parseScheduleTime(match[5]);

    rows.push({
      station_id: code,
      station_name: match[3].trim(),
      latitude: point.lat,
      longitude: point.lng,
      arrival_time: arrival?.time ?? null,
      departure_time: departure?.time ?? null,
      stop_sequence: Number(match[1]),
      day_offset: arrival?.dayOffset ?? departure?.dayOffset ?? 0
    });
  }

  return rows;
}

async function buildOnlineTrainSchedule(trainId: string, trainName: string) {
  const slug = slugifyTrainName(trainName);
  const url = `https://etrain.info/train/${slug}-${encodeURIComponent(trainId)}/schedule`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'RailwayRoutingExplorer/1.0 (+local development)',
      'accept': 'text/html'
    }
  });

  if (!response.ok) return null;

  const html = await response.text();
  const stops = parseScheduleRows(html);
  if (stops.length < 2) return null;

  return {
    train: {
      id: trainId,
      name: trainName,
      running_days: JSON.stringify(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    },
    schedule: stops
  };
}

export async function fetchOnlineTrainSchedule(trainId: string, trainName: string) {
  const cacheKey = `${trainId}:${trainName.toLowerCase()}`;
  const cached = onlineScheduleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await buildOnlineTrainSchedule(trainId, trainName);
  if (value) {
    onlineScheduleCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + ONLINE_SCHEDULE_CACHE_MS
    });
  }
  return value;
}

function parseRows(html: string) {
  const rows: OnlineTrainRow[] = [];
  const regex = /data-train='([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html))) {
    try {
      rows.push(JSON.parse(decodeHtml(match[1])) as OnlineTrainRow);
    } catch {
      // Ignore rows that do not parse cleanly.
    }
  }

  return rows;
}

export async function fetchOnlineDirectRoutes(sourceId: string, destinationId: string, requestedDate: Date): Promise<OnlineItinerary[]> {
  const destinationCandidates = ONLINE_DESTINATION_ALIASES[destinationId] ?? [destinationId];

  const seenRows = new Set<string>();
  const rows: OnlineTrainRow[] = [];

  for (const candidateDestinationId of destinationCandidates) {
    const url = `https://etrain.info/in?TRAIN_BETWEEN=${encodeURIComponent(sourceId)}-${encodeURIComponent(candidateDestinationId)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'RailwayRoutingExplorer/1.0 (+local development)',
      'accept': 'text/html'
    }
  });

    if (!response.ok) continue;

    const html = await response.text();
    const candidateRows = parseRows(html).filter(row => row.s === sourceId);

    for (const row of candidateRows) {
      const key = `${row.num}-${row.s}-${row.d}-${row.st}-${row.dt}`;
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      rows.push(row);
    }

    if (rows.length > 0) break;
  }

  const enriched = await Promise.all(rows.map(async row => {
    const duration = durationToMinutes(row.tt);
    const arrivalDayOffset = row.dt < row.st || duration >= 1440 ? 1 : 0;
    const onlineSchedule = await fetchOnlineTrainSchedule(row.num, row.name).catch(() => null);
    const routePoints = onlineSchedule
      ? scheduleRoutePoints(onlineSchedule.schedule, row.s, row.d)
      : [];

    return {
      source: 'online',
      segments: [{
        train_id: row.num,
        train_name: row.name,
        from_station_id: row.s,
        from_station_name: stationName(row.s),
        to_station_id: row.d,
        to_station_name: stationName(row.d),
        departure_time: row.st,
        arrival_time: row.dt,
        departure_day_offset: 0,
        arrival_day_offset: arrivalDayOffset,
        duration_minutes: duration,
        service_date: dateKey(requestedDate),
        route_points: routePoints
      }],
      total_transfers: 0,
      total_duration_minutes: duration,
      final_arrival_day_offset: arrivalDayOffset
    };
  }));

  return enriched;
}
