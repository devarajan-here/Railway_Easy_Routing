import db from '../db.ts';

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

interface Itinerary {
  segments: RouteSegment[];
  total_transfers: number;
  total_duration_minutes: number;
  final_arrival_day_offset: number;
}

interface ScheduleStop {
  train_id: string;
  station_id: string;
  station_name: string;
  latitude: number;
  longitude: number;
  arrival_time: string | null;
  departure_time: string | null;
  stop_sequence: number;
  day_offset: number;
}

interface TrainRow {
  id: string;
  name: string;
  running_days: string;
}

interface ServiceStop extends ScheduleStop {
  absolute_arrival_minute: number | null;
  absolute_departure_minute: number | null;
}

interface TrainService {
  serviceDate: Date;
  service_date_key: string;
  service_day_offset: number;
  train: TrainRow;
  stops: ServiceStop[];
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_TRANSFER_WAIT_MINUTES = 12 * 60;

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function minutesFromMidnight(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function stopDepartureMinute(stop: ServiceStop) {
  return stop.absolute_departure_minute ?? stop.absolute_arrival_minute;
}

function stopArrivalMinute(stop: ServiceStop) {
  return stop.absolute_arrival_minute ?? stop.absolute_departure_minute;
}

function isOnRequestedTravelDate(minute: number | null) {
  return minute !== null && minute >= 0 && minute < 1440;
}

function makeSegment(service: TrainService, from: ServiceStop, to: ServiceStop, routeStops?: ServiceStop[]): RouteSegment | null {
  const departureMinute = stopDepartureMinute(from);
  const arrivalMinute = stopArrivalMinute(to);

  if (departureMinute === null || arrivalMinute === null || arrivalMinute <= departureMinute) {
    return null;
  }

  return {
    train_id: service.train.id,
    train_name: service.train.name,
    from_station_id: from.station_id,
    from_station_name: from.station_name,
    to_station_id: to.station_id,
    to_station_name: to.station_name,
    departure_time: from.departure_time ?? from.arrival_time ?? '',
    arrival_time: to.arrival_time ?? to.departure_time ?? '',
    departure_day_offset: Math.floor(departureMinute / 1440),
    arrival_day_offset: Math.floor(arrivalMinute / 1440),
    duration_minutes: arrivalMinute - departureMinute,
    service_date: service.service_date_key,
    route_points: routeStops?.map(stop => ({
      id: stop.station_id,
      name: stop.station_name,
      lat: stop.latitude,
      lng: stop.longitude
    }))
  };
}

export function findRoutes(sourceId: string, destinationId: string, requestedDate: Date): Itinerary[] {
  const trainsStmt = db.prepare('SELECT id, name, running_days FROM trains');
  const allTrains = trainsStmt.all() as TrainRow[];

  const schedulesStmt = db.prepare(`
    SELECT s.train_id, s.station_id, st.name as station_name, st.latitude, st.longitude, s.arrival_time, s.departure_time, s.stop_sequence, s.day_offset
    FROM schedules s
    JOIN stations st ON s.station_id = st.id
    ORDER BY s.train_id, s.stop_sequence
  `);
  const allSchedules = schedulesStmt.all() as ScheduleStop[];

  const schedulesByTrain: Record<string, ScheduleStop[]> = {};
  for (const s of allSchedules) {
    if (!schedulesByTrain[s.train_id]) schedulesByTrain[s.train_id] = [];
    schedulesByTrain[s.train_id].push(s);
  }

  const services: TrainService[] = [];

  // Consider services starting on the requested date and the next day so a
  // transfer can leave after an overnight first leg.
  for (let serviceDayOffset = 0; serviceDayOffset <= 1; serviceDayOffset++) {
    const serviceDate = addDays(requestedDate, serviceDayOffset);
    const dayName = DAYS[serviceDate.getDay()];

    for (const train of allTrains) {
      const runningDays = JSON.parse(train.running_days) as string[];
      const rawStops = schedulesByTrain[train.id];
      if (!rawStops || !runningDays.includes(dayName)) continue;

      services.push({
        train,
        serviceDate,
        service_date_key: dateKey(serviceDate),
        service_day_offset: serviceDayOffset,
        stops: rawStops.map(stop => ({
          ...stop,
          absolute_arrival_minute: stop.arrival_time
            ? serviceDayOffset * 1440 + stop.day_offset * 1440 + minutesFromMidnight(stop.arrival_time)
            : null,
          absolute_departure_minute: stop.departure_time
            ? serviceDayOffset * 1440 + stop.day_offset * 1440 + minutesFromMidnight(stop.departure_time)
            : null
        }))
      });
    }
  }

  const itineraries: Itinerary[] = [];

  for (const service of services) {
    const sourceIndex = service.stops.findIndex(stop => stop.station_id === sourceId);
    const destIndex = service.stops.findIndex(stop => stop.station_id === destinationId);
    const sourceDepartureMinute = sourceIndex === -1 ? null : stopDepartureMinute(service.stops[sourceIndex]);

    if (sourceIndex !== -1 && destIndex !== -1 && sourceIndex < destIndex && isOnRequestedTravelDate(sourceDepartureMinute)) {
      const segment = makeSegment(
        service,
        service.stops[sourceIndex],
        service.stops[destIndex],
        service.stops.slice(sourceIndex, destIndex + 1)
      );
      if (!segment) continue;

      itineraries.push({
        segments: [segment],
        total_transfers: 0,
        total_duration_minutes: segment.duration_minutes,
        final_arrival_day_offset: segment.arrival_day_offset
      });
    }
  }

  for (const firstService of services) {
    const sourceIndex = firstService.stops.findIndex(stop => stop.station_id === sourceId);
    if (sourceIndex === -1) continue;
    const sourceDepartureMinute = stopDepartureMinute(firstService.stops[sourceIndex]);
    if (!isOnRequestedTravelDate(sourceDepartureMinute)) continue;

    for (let transferArrivalIndex = sourceIndex + 1; transferArrivalIndex < firstService.stops.length; transferArrivalIndex++) {
      const transferStop = firstService.stops[transferArrivalIndex];
      const transferArrivalMinute = stopArrivalMinute(transferStop);
      if (transferArrivalMinute === null) continue;

      for (const secondService of services) {
        if (secondService.train.id === firstService.train.id) {
          continue;
        }

        const transferDepartureIndex = secondService.stops.findIndex(stop => stop.station_id === transferStop.station_id);
        const destinationIndex = secondService.stops.findIndex(stop => stop.station_id === destinationId);
        if (transferDepartureIndex === -1 || destinationIndex === -1 || transferDepartureIndex >= destinationIndex) continue;

        const transferDepartureMinute = stopDepartureMinute(secondService.stops[transferDepartureIndex]);
        if (transferDepartureMinute === null || transferDepartureMinute < transferArrivalMinute) continue;
        if (transferDepartureMinute - transferArrivalMinute > MAX_TRANSFER_WAIT_MINUTES) continue;

        const firstSegment = makeSegment(
          firstService,
          firstService.stops[sourceIndex],
          transferStop,
          firstService.stops.slice(sourceIndex, transferArrivalIndex + 1)
        );
        const secondSegment = makeSegment(
          secondService,
          secondService.stops[transferDepartureIndex],
          secondService.stops[destinationIndex],
          secondService.stops.slice(transferDepartureIndex, destinationIndex + 1)
        );
        if (!firstSegment || !secondSegment) continue;

        const firstDepartureMinute = stopDepartureMinute(firstService.stops[sourceIndex]);
        const finalArrivalMinute = stopArrivalMinute(secondService.stops[destinationIndex]);
        if (firstDepartureMinute === null || finalArrivalMinute === null) continue;

        itineraries.push({
          segments: [firstSegment, secondSegment],
          total_transfers: 1,
          total_duration_minutes: finalArrivalMinute - firstDepartureMinute,
          final_arrival_day_offset: Math.floor(finalArrivalMinute / 1440)
        });
      }
    }
  }

  itineraries.sort((a, b) => {
    if (a.total_transfers !== b.total_transfers) {
      return a.total_transfers - b.total_transfers;
    }
    return a.total_duration_minutes - b.total_duration_minutes;
  });

  return itineraries.slice(0, 10);
}
