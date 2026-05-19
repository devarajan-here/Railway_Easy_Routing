import { Router } from 'express';

const router = Router();

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '1',
      countrycodes: 'in'
    });

    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: {
        'accept': 'application/json',
        'user-agent': 'RailwayEasyRouting/1.0 (https://devarajan.site)'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Location search failed' });
    }

    res.json(await response.json());
  } catch (err) {
    console.error('Error searching place:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
