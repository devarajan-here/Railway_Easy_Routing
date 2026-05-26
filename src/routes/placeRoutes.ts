import { Router } from 'express';
import { OpenLocationCode } from 'open-location-code';

const router = Router();
const USER_AGENT = 'RailwayEasyRouting/1.0 (https://devarajan.site)';
const openLocationCode = new OpenLocationCode();

interface PlaceResult {
  place_id?: string | number;
  name?: string;
  display_name?: string;
  lat: string;
  lon: string;
  source?: string;
}

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

function extractPlusCode(query: string) {
  const match = query.toUpperCase().match(/\b[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,}\b/);
  if (!match) return null;

  const code = match[0];
  const referenceQuery = query
    .replace(match[0], '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/^,\s*|\s*,\s*$/g, '')
    .trim();

  return { code, referenceQuery };
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

  if (!response.ok) return [] as PlaceResult[];
  const data = await response.json();
  return Array.isArray(data) ? data as PlaceResult[] : [];
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

  if (!response.ok) return [] as PlaceResult[];
  const data = await response.json();
  return Array.isArray(data) ? data as PlaceResult[] : [];
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
    }) as PlaceResult[];
}

function dedupePlaces(results: PlaceResult[]) {
  const seen = new Set<string>();
  return results.filter(result => {
    const key = `${Number(result.lat).toFixed(5)},${Number(result.lon).toFixed(5)}:${result.display_name || result.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchAllCandidates(query: string) {
  const pincode = query.match(/\b\d{6}\b/)?.[0];
  const collected: PlaceResult[] = [];

  for (const candidate of queryCandidates(query)) {
    collected.push(...await searchNominatimFreeform(candidate));
    if (collected.length >= 3) break;
  }

  if (pincode && collected.length < 3) {
    collected.push(...await searchNominatimPincode(pincode));
  }

  if (collected.length < 3) {
    for (const candidate of queryCandidates(query)) {
      collected.push(...await searchPhoton(candidate));
      if (collected.length >= 3) break;
    }
  }

  return dedupePlaces(collected).slice(0, 5);
}

async function resolvePlusCode(query: string) {
  const plusCode = extractPlusCode(query);
  if (!plusCode) return null;

  try {
    let fullCode = plusCode.code;

    if (!openLocationCode.isFull(plusCode.code)) {
      const referenceResults = plusCode.referenceQuery
        ? await searchAllCandidates(plusCode.referenceQuery)
        : [];
      const reference = referenceResults[0];
      if (!reference) return null;

      fullCode = openLocationCode.recoverNearest(
        plusCode.code,
        Number(reference.lat),
        Number(reference.lon)
      );
    }

    const decoded = openLocationCode.decode(fullCode);
    const name = plusCode.referenceQuery || plusCode.code;
    return {
      place_id: `plus:${fullCode}`,
      name,
      display_name: `${plusCode.code}, ${name}`,
      lat: String(decoded.latitudeCenter),
      lon: String(decoded.longitudeCenter),
      source: 'plus_code'
    } as PlaceResult;
  } catch (err) {
    console.warn('Plus code lookup failed:', err);
    return null;
  }
}

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const plusCodeResult = await resolvePlusCode(query);
    if (plusCodeResult) {
      return res.json([plusCodeResult]);
    }

    res.json(await searchAllCandidates(query));
  } catch (err) {
    console.error('Error searching place:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
