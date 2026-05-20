import { Router } from 'express';

const router = Router();
const USER_AGENT = 'RailwayEasyRouting/1.0 (https://devarajan.site)';

function normalizePlaceQuery(query: string) {
  return query
    .replace(/\bthiruppati\b/ig, 'tirupati')
    .replace(/\btiruppati\b/ig, 'tirupati')
    .replace(/\bthirupathi\b/ig, 'tirupati')
    .replace(/\btirupathi\b/ig, 'tirupati')
    .replace(/\btrissur\b/ig, 'thrissur')
    .replace(/\bthrisur\b/ig, 'thrissur')
    .replace(/\btrivandrum\b/ig, 'thiruvananthapuram')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryCandidates(query: string) {
  const normalized = normalizePlaceQuery(query);
  const pincode = normalized.match(/\b\d{6}\b/)?.[0];
  const candidates = new Set<string>();

  candidates.add(query);
  candidates.add(normalized);
  candidates.add(`${normalized}, India`);

  if (pincode) {
    const placePart = normalized.replace(pincode, '').trim().replace(/,+$/, '');
    if (placePart) {
      candidates.add(`${placePart}, ${pincode}, India`);
      candidates.add(`${placePart}, Kerala, ${pincode}, India`);
      candidates.add(`${placePart}, Tamil Nadu, ${pincode}, India`);
    }
    candidates.add(`${pincode}, India`);
  }

  return [...candidates].filter(Boolean);
}

async function searchNominatimFreeform(query: string) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '3',
    countrycodes: 'in'
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      'accept': 'application/json',
      'user-agent': USER_AGENT
    }
  });

  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function searchNominatimPincode(pincode: string) {
  const params = new URLSearchParams({
    postalcode: pincode,
    country: 'India',
    format: 'jsonv2',
    addressdetails: '1',
    limit: '3'
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      'accept': 'application/json',
      'user-agent': USER_AGENT
    }
  });

  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function searchPhoton(query: string) {
  const params = new URLSearchParams({
    q: query,
    limit: '5',
    lang: 'en'
  });

  const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
    headers: {
      'accept': 'application/json',
      'user-agent': USER_AGENT
    }
  });

  if (!response.ok) return [];

  const data = await response.json() as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: Record<string, string>;
    }>;
  };

  return (data.features || [])
    .filter(feature => feature.properties?.countrycode === 'IN')
    .filter(feature => Array.isArray(feature.geometry?.coordinates))
    .map(feature => {
      const properties = feature.properties || {};
      const [lon, lat] = feature.geometry!.coordinates!;
      const parts = [
        properties.name,
        properties.city,
        properties.county,
        properties.state,
        properties.country
      ].filter(Boolean);

      return {
        place_id: properties.osm_id || properties.name || `${lat},${lon}`,
        name: properties.name || query,
        display_name: [...new Set(parts)].join(', '),
        lat: String(lat),
        lon: String(lon),
        source: 'photon'
      };
    });
}

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const pincode = query.match(/\b\d{6}\b/)?.[0];

    for (const candidate of queryCandidates(query)) {
      const nominatimResults = await searchNominatimFreeform(candidate);
      if (nominatimResults.length > 0) {
        return res.json(nominatimResults);
      }
    }

    if (pincode) {
      const pincodeResults = await searchNominatimPincode(pincode);
      if (pincodeResults.length > 0) {
        return res.json(pincodeResults);
      }
    }

    for (const candidate of queryCandidates(query)) {
      const photonResults = await searchPhoton(candidate);
      if (photonResults.length > 0) {
        return res.json(photonResults);
      }
    }

    res.json([]);
  } catch (err) {
    console.error('Error searching place:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
