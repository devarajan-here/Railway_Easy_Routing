import db from '../db.ts';

interface ScheduleStop {
  arrival_time: string | null;
  departure_time: string | null;
  stop_sequence: number;
  day_offset: number;
  station_name: string;
  latitude: number;
  longitude: number;
  station_id: string;
}

interface DatedStop extends ScheduleStop {
  arrDate: Date | null;
  depDate: Date | null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseTime(baseDay: Date, timeStr: string, dayOffset: number) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const d = addDays(baseDay, dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function buildDatedStops(schedule: ScheduleStop[], serviceDate: Date): DatedStop[] {
  const serviceStart = startOfDay(serviceDate);

  return schedule.map(stop => ({
    ...stop,
    arrDate: stop.arrival_time ? parseTime(serviceStart, stop.arrival_time, stop.day_offset) : null,
    depDate: stop.departure_time ? parseTime(serviceStart, stop.departure_time, stop.day_offset) : null
  }));
}

function classifyStatus(stops: DatedStop[], currentSystemTime: Date) {
  const firstStop = stops[0];
  const lastStop = stops[stops.length - 1];
  const firstDeparture = firstStop.depDate ?? firstStop.arrDate;
  const lastArrival = lastStop.arrDate ?? lastStop.depDate;

  if (!firstDeparture || !lastArrival) {
    return { error: 'Schedule is missing origin or destination timing' };
  }

  if (currentSystemTime < firstDeparture) {
    return {
      status: 'NOT_STARTED',
      message: `Waiting at origin: ${firstStop.station_name}`,
      location: { lat: firstStop.latitude, lng: firstStop.longitude },
      current_station: {
        id: firstStop.station_id,
        name: firstStop.station_name,
        lat: firstStop.latitude,
        lng: firstStop.longitude
      },
      next_station: stops[1] ? {
        id: stops[1].station_id,
        name: stops[1].station_name,
        lat: stops[1].latitude,
        lng: stops[1].longitude
      } : null,
      next_event_time: firstDeparture.toISOString()
    };
  }

  if (currentSystemTime >= lastArrival) {
    return {
      status: 'COMPLETED',
      message: `Reached destination: ${lastStop.station_name}`,
      location: { lat: lastStop.latitude, lng: lastStop.longitude },
      current_station: {
        id: lastStop.station_id,
        name: lastStop.station_name,
        lat: lastStop.latitude,
        lng: lastStop.longitude
      },
      previous_station: stops.length > 1 ? {
        id: stops[stops.length - 2].station_id,
        name: stops[stops.length - 2].station_name,
        lat: stops[stops.length - 2].latitude,
        lng: stops[stops.length - 2].longitude
      } : null,
      completed_at: lastArrival.toISOString()
    };
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const current = stops[i];
    const next = stops[i + 1];

    if (current.arrDate && current.depDate && currentSystemTime >= current.arrDate && currentSystemTime <= current.depDate) {
      return {
        status: 'HALTED',
        message: `Halted at ${current.station_name}`,
        location: { lat: current.latitude, lng: current.longitude },
        current_station: {
          id: current.station_id,
          name: current.station_name,
          lat: current.latitude,
          lng: current.longitude
        },
        previous_station: i > 0 ? {
          id: stops[i - 1].station_id,
          name: stops[i - 1].station_name,
          lat: stops[i - 1].latitude,
          lng: stops[i - 1].longitude
        } : null,
        next_station: next ? {
          id: next.station_id,
          name: next.station_name,
          lat: next.latitude,
          lng: next.longitude
        } : null,
        next_event_time: current.depDate.toISOString()
      };
    }

    const departTime = current.depDate ?? current.arrDate;
    const arriveTime = next.arrDate ?? next.depDate;
    if (!departTime || !arriveTime) continue;

    if (currentSystemTime >= departTime && currentSystemTime < arriveTime) {
      const totalMinutes = (arriveTime.getTime() - departTime.getTime()) / 60000;
      const elapsedMinutes = (currentSystemTime.getTime() - departTime.getTime()) / 60000;
      const progress = Math.max(0, Math.min(1, elapsedMinutes / totalMinutes));

      const lat = current.latitude + (next.latitude - current.latitude) * progress;
      const lng = current.longitude + (next.longitude - current.longitude) * progress;

      return {
        status: 'IN_TRANSIT',
        message: `Departed ${current.station_name}, en route to ${next.station_name}`,
        location: { lat, lng },
        progress_percent: Math.round(progress * 100),
        previous_station: {
          id: current.station_id,
          name: current.station_name,
          lat: current.latitude,
          lng: current.longitude
        },
        next_station: {
          id: next.station_id,
          name: next.station_name,
          lat: next.latitude,
          lng: next.longitude
        },
        segment: {
          from_station_id: current.station_id,
          from_station_name: current.station_name,
          to_station_id: next.station_id,
          to_station_name: next.station_name,
          departure_time: departTime.toISOString(),
          arrival_time: arriveTime.toISOString()
        },
        next_event_time: arriveTime.toISOString()
      };
    }
  }

  return { error: 'Could not determine status' };
}

export function getLiveTrainStatusFromSchedule(train: any, schedule: ScheduleStop[], currentSystemTime: Date = new Date()) {
  if (schedule.length === 0) return { error: 'No schedule found' };

  const runningDays = JSON.parse(train.running_days) as string[];
  const today = startOfDay(currentSystemTime);
  const candidates = [];

  for (let offset = -3; offset <= 1; offset++) {
    const serviceDate = addDays(today, offset);
    if (!runningDays.includes(DAYS[serviceDate.getDay()])) continue;

    const stops = buildDatedStops(schedule, serviceDate);
    const firstDeparture = stops[0].depDate ?? stops[0].arrDate;
    const lastArrival = stops[stops.length - 1].arrDate ?? stops[stops.length - 1].depDate;
    if (!firstDeparture || !lastArrival) continue;

    candidates.push({ serviceDate, stops, firstDeparture, lastArrival });
  }

  const active = candidates.find(candidate => (
    currentSystemTime >= candidate.firstDeparture && currentSystemTime < candidate.lastArrival
  ));

  if (active) {
    return {
      train,
      service_date: dateKey(active.serviceDate),
      route_points: active.stops.map(stop => ({
        id: stop.station_id,
        name: stop.station_name,
        lat: stop.latitude,
        lng: stop.longitude,
        arrival_time: stop.arrDate?.toISOString() ?? null,
        departure_time: stop.depDate?.toISOString() ?? null
      })),
      ...classifyStatus(active.stops, currentSystemTime)
    };
  }

  const next = candidates
    .filter(candidate => currentSystemTime < candidate.firstDeparture)
    .sort((a, b) => a.firstDeparture.getTime() - b.firstDeparture.getTime())[0];

  if (next) {
    return {
      train,
      service_date: dateKey(next.serviceDate),
      route_points: next.stops.map(stop => ({
        id: stop.station_id,
        name: stop.station_name,
        lat: stop.latitude,
        lng: stop.longitude,
        arrival_time: stop.arrDate?.toISOString() ?? null,
        departure_time: stop.depDate?.toISOString() ?? null
      })),
      ...classifyStatus(next.stops, currentSystemTime)
    };
  }

  const previous = candidates
    .filter(candidate => currentSystemTime >= candidate.lastArrival)
    .sort((a, b) => b.lastArrival.getTime() - a.lastArrival.getTime())[0];

  if (previous) {
    return {
      train,
      service_date: dateKey(previous.serviceDate),
      route_points: previous.stops.map(stop => ({
        id: stop.station_id,
        name: stop.station_name,
        lat: stop.latitude,
        lng: stop.longitude,
        arrival_time: stop.arrDate?.toISOString() ?? null,
        departure_time: stop.depDate?.toISOString() ?? null
      })),
      ...classifyStatus(previous.stops, currentSystemTime)
    };
  }

  return { error: 'Train does not run near the selected time' };
}

export function getLiveTrainStatus(trainId: string, currentSystemTime: Date = new Date()) {
  const train = db.prepare('SELECT * FROM trains WHERE id = ?').get(trainId) as any;
  if (!train) return { error: 'Train not found' };

  const schedule = db.prepare(`
    SELECT s.arrival_time, s.departure_time, s.stop_sequence, s.day_offset, st.name as station_name, st.latitude, st.longitude, st.id as station_id
    FROM schedules s
    JOIN stations st ON s.station_id = st.id
    WHERE s.train_id = ?
    ORDER BY s.stop_sequence ASC
  `).all(trainId) as ScheduleStop[];

  return getLiveTrainStatusFromSchedule(train, schedule, currentSystemTime);
}
