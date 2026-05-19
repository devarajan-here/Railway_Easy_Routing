import { Router } from 'express';
import db from '../db';
import { findRoutes } from '../services/routing';
import { getLiveTrainStatus, getLiveTrainStatusFromSchedule } from '../services/liveStatus';
import { fetchOnlineDirectRoutes, fetchOnlineTrainSchedule, OnlineItinerary } from '../services/onlineTrains';
import { findRouteSuggestions } from '../services/routeSuggestions';

const router = Router();

// Get all trains
router.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM trains');
    res.json(stmt.all());
  } catch(e) {
    res.status(500).json({error: 'Internal server error'});
  }
});

// Get train schedule
router.get('/:id/schedule', (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare(`
      SELECT s.arrival_time, s.departure_time, s.stop_sequence, s.day_offset, st.name as station_name, st.id as station_id
      FROM schedules s
      JOIN stations st ON s.station_id = st.id
      WHERE s.train_id = ?
      ORDER BY s.stop_sequence ASC
    `);
    const schedule = stmt.all(id);
    
    if (schedule.length === 0) {
      return res.status(404).json({ error: 'Train not found or has no schedule' });
    }

    const trainStmt = db.prepare('SELECT * FROM trains WHERE id = ?');
    const train = trainStmt.get(id);

    res.json({
      train,
      schedule
    });
  } catch (err) {
    console.error('Error fetching train schedule:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Calculate routes
// GET /api/trains/routes?source=S1&destination=S4&date=2026-05-20
router.get('/routes', async (req, res) => {
  try {
    const source = req.query.source as string;
    const destination = req.query.destination as string;
    const dateStr = req.query.date as string; // YYYY-MM-DD

    if (!source || !destination) {
      return res.status(400).json({ error: 'Source and destination are required' });
    }

    const requestedDate = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();

    const localRoutes = findRoutes(source, destination, requestedDate);
    let onlineRoutes: OnlineItinerary[] = [];

    try {
      onlineRoutes = await fetchOnlineDirectRoutes(source, destination, requestedDate);
    } catch (onlineErr) {
      console.warn('Online train lookup failed:', onlineErr);
    }

    const routeSource = onlineRoutes.length > 0 ? onlineRoutes : localRoutes;
    const seen = new Set<string>();
    const possibleRoutes = routeSource.filter(route => {
      const key = route.segments.map((segment: { train_id: string }) => segment.train_id).join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    possibleRoutes.sort((a, b) => {
      if (a.total_transfers !== b.total_transfers) return a.total_transfers - b.total_transfers;
      return a.total_duration_minutes - b.total_duration_minutes;
    });

    res.json(possibleRoutes);

  } catch (err) {
    console.error('Error finding routes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Suggest nearby interchange stations when no direct route is found.
// GET /api/trains/routes/suggestions?source=IJK&destination=MYS&date=2026-05-20
router.get('/routes/suggestions', async (req, res) => {
  try {
    const source = req.query.source as string;
    const destination = req.query.destination as string;
    const dateStr = req.query.date as string;

    if (!source || !destination) {
      return res.status(400).json({ error: 'Source and destination are required' });
    }

    const requestedDate = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
    res.json(await findRouteSuggestions(source, destination, requestedDate));
  } catch (err) {
    console.error('Error finding route suggestions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/trains/:id/live
router.get('/:id/live', (req, res) => {
  try {
    // Optionally allow passing a simulated time: ?time=14:30
    const timeParam = req.query.time as string;
    let systemTime = new Date();
    if (timeParam) {
      const parts = timeParam.split(':');
      systemTime.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    }
    
    let status = getLiveTrainStatus(req.params.id, systemTime);
    const trainName = req.query.trainName as string | undefined;

    if (status.error === 'Train not found' && trainName) {
      return fetchOnlineTrainSchedule(req.params.id, trainName)
        .then(onlineSchedule => {
          if (!onlineSchedule) {
            res.status(404).json({ error: 'Train schedule not found online' });
            return;
          }

          res.json(getLiveTrainStatusFromSchedule(onlineSchedule.train, onlineSchedule.schedule, systemTime));
        })
        .catch(err => {
          console.error('Error fetching online live schedule:', err);
          res.status(500).json({ error: 'Online schedule lookup failed' });
        });
    }

    res.json(status);
  } catch (err) {
    console.error('Error getting live status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
