import { Router } from 'express';
import db from '../db';

const router = Router();

router.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT id, name, latitude as lat, longitude as lng FROM stations ORDER BY name COLLATE NOCASE');
    const stations = stmt.all();
    res.json(stations);
  } catch (err) {
    console.error('Error fetching stations:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
