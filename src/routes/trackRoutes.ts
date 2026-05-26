import { Router } from 'express';
import { snapRouteToRailway } from '../services/trackSnap';

const router = Router();

router.post('/snap', async (req, res) => {
  try {
    const points = req.body?.points;
    if (!Array.isArray(points) || points.length < 2) {
      return res.status(400).json({ error: 'At least two route points are required' });
    }

    res.json(await snapRouteToRailway(points));
  } catch (err) {
    console.error('Error snapping route to railway tracks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
