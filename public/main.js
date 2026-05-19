// Frontend logic for Railway Routing Explorer.
// Uses native fetch and Leaflet (loaded from CDN)

const map = L.map('map', { preferCanvas: true }).setView([20.5937, 78.9629], 5); // Center India
const stationRenderer = L.canvas({ padding: 0.5 });
const dynamicStationLayer = L.layerGroup().addTo(map);
window.railwayMap = map;
let userLocationMarker = null;
let userAccuracyCircle = null;
let placeSearchMarker = null;
const nearbyStationLayer = L.layerGroup().addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

function showUserLocation(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const latLng = [latitude, longitude];

  if (!userLocationMarker) {
    userLocationMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: 'user-location-marker',
        html: '<span></span>',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      })
    }).addTo(map);
    userLocationMarker.bindTooltip('You are here', {
      permanent: true,
      direction: 'top',
      className: 'station-label user-location-label'
    });
  } else {
    userLocationMarker.setLatLng(latLng);
  }

  if (!userAccuracyCircle) {
    userAccuracyCircle = L.circle(latLng, {
      radius: accuracy || 50,
      color: '#1e90ff',
      weight: 2,
      fillColor: '#1e90ff',
      fillOpacity: 0.14
    }).addTo(map);
  } else {
    userAccuracyCircle.setLatLng(latLng);
    userAccuracyCircle.setRadius(accuracy || 50);
  }

  userLocationMarker.openTooltip();
  map.setView(latLng, Math.max(map.getZoom(), 15));
}

function handleUserLocationError(error) {
  const message = error.code === 1
    ? 'Location permission was blocked. Allow location access in the browser to use GPS.'
    : 'Could not detect your location right now.';
  alert(message);
}

function locateUser() {
  if (!navigator.geolocation) {
    alert('GPS location is not supported in this browser.');
    return;
  }

  navigator.geolocation.getCurrentPosition(showUserLocation, handleUserLocationError, {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 0
  });
}

const GpsControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar gps-control');
    const button = L.DomUtil.create('button', '', container);
    button.type = 'button';
    button.title = 'Show my GPS location';
    button.setAttribute('aria-label', 'Show my GPS location');
    button.textContent = 'GPS';

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(button, 'click', (event) => {
      L.DomEvent.preventDefault(event);
      locateUser();
    });

    return container;
  }
});

map.addControl(new GpsControl());

function distanceKmBetween(a, b) {
  const earthRadiusKm = 6371;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * Math.PI / 180;
  const deltaLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestStationsTo(point, limit = 6) {
  return stations
    .filter(st => Number.isFinite(st.lat) && Number.isFinite(st.lng))
    .map(st => ({
      ...st,
      distance_km: distanceKmBetween(point, { lat: st.lat, lng: st.lng })
    }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

function showNearbyStations(point, placeName) {
  nearbyStationLayer.clearLayers();
  const nearest = nearestStationsTo(point);
  const resultsDiv = document.getElementById('results');

  nearest.forEach((station, index) => {
    const marker = createStationDot(station, {
      radius: index === 0 ? 8 : 6,
      color: index === 0 ? '#ff9800' : '#00b894',
      fillColor: index === 0 ? '#ff9800' : '#00b894',
      permanentLabel: true
    });
    marker.bindPopup(`${stationLabel(station)}<br>${station.distance_km.toFixed(1)} km from ${placeName}`);
    nearbyStationLayer.addLayer(marker);
  });

  resultsDiv.style.display = 'block';
  resultsDiv.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'result-card nearby-stations-card';
  const heading = document.createElement('h3');
  heading.textContent = `Nearest stations to ${placeName}`;
  card.appendChild(heading);

  nearest.forEach(station => {
    const row = document.createElement('div');
    row.className = 'nearby-station-row';

    const text = document.createElement('span');
    text.textContent = `${stationLabel(station)} - ${station.distance_km.toFixed(1)} km`;
    row.appendChild(text);

    const fromButton = document.createElement('button');
    fromButton.type = 'button';
    fromButton.textContent = 'From';
    fromButton.addEventListener('click', () => {
      setStationSelection(
        document.getElementById('startStationSearch'),
        document.getElementById('startStation'),
        document.getElementById('startStationSuggestions'),
        station
      );
    });
    row.appendChild(fromButton);

    const toButton = document.createElement('button');
    toButton.type = 'button';
    toButton.textContent = 'To';
    toButton.addEventListener('click', () => {
      setStationSelection(
        document.getElementById('endStationSearch'),
        document.getElementById('endStation'),
        document.getElementById('endStationSuggestions'),
        station
      );
    });
    row.appendChild(toButton);

    card.appendChild(row);
  });

  resultsDiv.appendChild(card);
}

async function searchPlace(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return;

  const params = new URLSearchParams({ q: cleanQuery });
  const response = await fetch(`/api/places/search?${params.toString()}`);
  if (!response.ok) throw new Error('Location search failed');

  const matches = await response.json();
  if (!Array.isArray(matches) || matches.length === 0) {
    alert('Location not found. Try adding state name, like "Thoothukudi Tamil Nadu".');
    return;
  }

  const place = matches[0];
  const point = {
    lat: Number(place.lat),
    lng: Number(place.lon)
  };
  const placeName = place.name || cleanQuery;

  if (!placeSearchMarker) {
    placeSearchMarker = L.marker([point.lat, point.lng], {
      icon: L.divIcon({
        className: 'place-search-marker',
        html: '<span></span>',
        iconSize: [28, 28],
        iconAnchor: [14, 26]
      })
    }).addTo(map);
  } else {
    placeSearchMarker.setLatLng([point.lat, point.lng]);
  }

  placeSearchMarker.bindTooltip(placeName, {
    permanent: true,
    direction: 'top',
    className: 'station-label place-search-label'
  }).openTooltip();

  routeFocusActive = false;
  map.setView([point.lat, point.lng], 13);
  showNearbyStations(point, placeName);
}

const PlaceSearchControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar place-search-control');
    const form = L.DomUtil.create('form', '', container);
    const input = L.DomUtil.create('input', '', form);
    const button = L.DomUtil.create('button', '', form);

    input.type = 'search';
    input.placeholder = 'Search place';
    input.setAttribute('aria-label', 'Search place on map');
    button.type = 'submit';
    button.title = 'Search place';
    button.setAttribute('aria-label', 'Search place');
    button.textContent = 'Go';

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    L.DomEvent.on(form, 'submit', async (event) => {
      L.DomEvent.preventDefault(event);
      button.disabled = true;
      button.textContent = '...';
      try {
        await searchPlace(input.value);
      } catch (e) {
        console.error(e);
        alert('Could not search this place right now.');
      } finally {
        button.disabled = false;
        button.textContent = 'Go';
      }
    });

    return container;
  }
});

map.addControl(new PlaceSearchControl());

let stations = [];
let trains = [];
const stationMarkers = {};
const majorStationIds = new Set([
  'NDLS', 'DLI', 'BCT', 'CSTM', 'LTT', 'BDTS', 'ADI', 'HWH', 'SDAH', 'KOAA',
  'MAS', 'MS', 'SBC', 'YPR', 'SC', 'HYB', 'PUNE', 'JP', 'JU', 'AII',
  'LKO', 'LJN', 'CNB', 'GKP', 'BSB', 'PNBE', 'GAYA', 'BPL', 'INDB',
  'NGP', 'BBS', 'PURI', 'VSKP', 'VGA', 'TPTY', 'CBE', 'ERS', 'TVC',
  'MAJN', 'MAQ', 'MYS', 'UBL', 'BZA', 'RNC', 'JAT', 'ASR', 'UMB',
  'LDH', 'AADR', 'GWL', 'AGC', 'AF', 'KOTA', 'RTM', 'AII', 'RJT',
  'BRC', 'ST', 'NDB', 'JBP', 'BSP', 'R', 'DBRG', 'GHY', 'NJP',
  'MLDT', 'KGP', 'TCR', 'MDU', 'TPJ', 'SA', 'ERS'
]);
const selectedStationIds = new Set();
let liveTrainInterval = null;
let liveTrainMarker = null;
let liveRouteLine = null;
let liveSegmentLine = null;
let activeLiveTrainName = '';
let stationRenderTimer = null;
let routeFocusActive = false;
const savedStateKey = 'railwayRoutingLastSearch';

function readSavedState() {
  try {
    return JSON.parse(localStorage.getItem(savedStateKey) || '{}');
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    localStorage.setItem(savedStateKey, JSON.stringify({
      ...readSavedState(),
      ...patch
    }));
  } catch (e) {
    console.warn('Could not save last railway search', e);
  }
}

async function loadStationsAndTrains() {
  try {
    const [stRes, trRes] = await Promise.all([
      fetch('/api/stations'),
      fetch('/api/trains')
    ]);
    if (!stRes.ok || !trRes.ok) throw new Error('Failed to fetch data');
    
    stations = await stRes.json();
    trains = await trRes.json();
    stations.sort((a, b) => a.name.localeCompare(b.name));
    
    populateDropdowns();
    renderStationMarkers();
  } catch (e) {
    console.error(e);
  }
}

function populateDropdowns() {
  const trainSel = document.getElementById('trainSelect');
  const savedState = readSavedState();

  setupStationSearch('startStationSearch', 'startStation', 'startStationSuggestions', savedState.source || 'NDLS');
  setupStationSearch('endStationSearch', 'endStation', 'endStationSuggestions', savedState.destination || 'BCT');

  if (savedState.date) {
    document.getElementById('travelDate').value = savedState.date;
  }
  if (savedState.liveTime) {
    document.getElementById('liveTime').value = savedState.liveTime;
  }

  const optDefault = document.createElement('option');
  optDefault.value = "";
  optDefault.textContent = "-- Select a Train --";
  trainSel.appendChild(optDefault);

  trains.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    opt.dataset.trainName = t.name;
    trainSel.appendChild(opt);
  });

  if (savedState.liveTrainId && ![...trainSel.options].some(opt => opt.value === savedState.liveTrainId)) {
    const opt = document.createElement('option');
    opt.value = savedState.liveTrainId;
    opt.textContent = savedState.liveTrainLabel || `${savedState.liveTrainName || 'Last train'} (${savedState.liveTrainId})`;
    opt.dataset.trainName = savedState.liveTrainName || savedState.liveTrainLabel || '';
    trainSel.appendChild(opt);
  }

  if (savedState.liveTrainId) {
    trainSel.value = savedState.liveTrainId;
    activeLiveTrainName = savedState.liveTrainName || trainSel.selectedOptions[0]?.dataset.trainName || '';
  }
}

function stationLabel(st) {
  return `${st.name} (${st.id})`;
}

function normalizeStationText(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findStationMatch(value) {
  const query = normalizeStationText(value).replace(/\s*\([^)]+\)\s*$/, '');
  if (!query) return null;

  return stations.find(st => st.id.toLowerCase() === query)
    || stations.find(st => normalizeStationText(st.name) === query)
    || stations.find(st => normalizeStationText(stationLabel(st)) === normalizeStationText(value))
    || stations.find(st => st.id.toLowerCase().startsWith(query))
    || stations.find(st => normalizeStationText(st.name).startsWith(query))
    || stations.find(st => normalizeStationText(st.name).includes(query) || st.id.toLowerCase().includes(query))
    || null;
}

function setStationSelection(input, hidden, suggestions, station) {
  input.value = stationLabel(station);
  hidden.value = station.id;
  suggestions.style.display = 'none';
  suggestions.innerHTML = '';
  selectedStationIds.add(station.id);
  if (!routeFocusActive) {
    createStationMarker(station);
  }
  renderStationMarkers();
}

function resolveStationInput(inputId, hiddenId, suggestionsId) {
  const input = document.getElementById(inputId);
  const hidden = document.getElementById(hiddenId);
  const suggestions = document.getElementById(suggestionsId);

  if (hidden.value) return hidden.value;

  const station = findStationMatch(input.value);
  if (!station) return '';

  setStationSelection(input, hidden, suggestions, station);
  return hidden.value;
}

function setupStationSearch(inputId, hiddenId, suggestionsId, defaultStationId) {
  const input = document.getElementById(inputId);
  const hidden = document.getElementById(hiddenId);
  const suggestions = document.getElementById(suggestionsId);
  const fallbackStationId = inputId === 'startStationSearch' ? 'NDLS' : 'BCT';
  const defaultStation = stations.find(st => st.id === defaultStationId)
    || stations.find(st => st.id === fallbackStationId);

  if (defaultStation) {
    setStationSelection(input, hidden, suggestions, defaultStation);
  }

  input.addEventListener('input', () => {
    hidden.value = '';
    const query = input.value.trim().toLowerCase();
    suggestions.innerHTML = '';

    if (query.length < 2) {
      suggestions.style.display = 'none';
      return;
    }

    const matches = stations
      .filter(st => st.name.toLowerCase().includes(query) || st.id.toLowerCase().includes(query))
      .slice(0, 40);

    matches.forEach(st => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = stationLabel(st);
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        setStationSelection(input, hidden, suggestions, st);
      });
      button.addEventListener('click', () => setStationSelection(input, hidden, suggestions, st));
      suggestions.appendChild(button);
    });

    suggestions.style.display = matches.length ? 'block' : 'none';
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      suggestions.style.display = 'none';
    }, 150);
  });
}

function isMajorStation(st) {
  return majorStationIds.has(st.id);
}

function isImportantStation(st) {
  return isMajorStation(st)
    || /\b(JN|JUNCTION|CENTRAL|CANTT|CITY|TERMINUS|TERMINAL)\b/i.test(st.name)
    || st.id.length <= 3;
}

function selectStationAsStart(st) {
  const input = document.getElementById('startStationSearch');
  const hidden = document.getElementById('startStation');
  const suggestions = document.getElementById('startStationSuggestions');
  setStationSelection(input, hidden, suggestions, st);
}

function createStationDot(st, options = {}) {
  const zoom = map.getZoom();
  const major = isMajorStation(st);
  const important = isImportantStation(st);
  const radius = options.radius || (major ? 6 : important ? 4.5 : 3);
  const color = options.color || (major ? '#d00000' : important ? '#f06423' : '#096c56');
  const fillColor = options.fillColor || color;

  const marker = L.circleMarker([st.lat, st.lng], {
    renderer: stationRenderer,
    radius,
    weight: major ? 2 : 1,
    color,
    fillColor,
    fillOpacity: major ? 0.95 : 0.82
  });

  const permanentLabel = options.permanentLabel ?? (major || zoom >= 10);
  marker.bindTooltip(stationLabel(st), {
    permanent: permanentLabel,
    direction: 'right',
    className: major ? 'station-label major-station-label' : 'station-label'
  });
  marker.on('click', () => selectStationAsStart(st));

  return marker;
}

function createStationMarker(st, options = {}) {
  if (stationMarkers[st.id]) return stationMarkers[st.id];

  const marker = createStationDot(st, {
    radius: options.radius || 7,
    color: options.color || '#1e90ff',
    fillColor: options.fillColor || options.color || '#1e90ff',
    permanentLabel: true
  }).addTo(map);
  stationMarkers[st.id] = marker;
  return marker;
}

function clearPinnedStationMarkers() {
  Object.values(stationMarkers).forEach(marker => map.removeLayer(marker));
  Object.keys(stationMarkers).forEach(id => delete stationMarkers[id]);
}

function pickStationsForZoom() {
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.15);
  const inView = stations.filter(st => bounds.contains([st.lat, st.lng]));

  if (zoom <= 5) {
    return stations.filter(isMajorStation);
  }

  if (zoom <= 7) {
    return [
      ...stations.filter(isMajorStation),
      ...inView.filter(st => isImportantStation(st) && !isMajorStation(st)).slice(0, 700)
    ];
  }

  if (zoom <= 9) {
    return inView
      .filter(st => isImportantStation(st) || selectedStationIds.has(st.id))
      .slice(0, 1200);
  }

  return inView;
}

function renderStationMarkers() {
  if (!stations.length) return;

  dynamicStationLayer.clearLayers();
  if (routeFocusActive) return;

  const rendered = new Set();
  for (const st of pickStationsForZoom()) {
    if (stationMarkers[st.id] || rendered.has(st.id)) continue;
    dynamicStationLayer.addLayer(createStationDot(st));
    rendered.add(st.id);
  }
}

function scheduleStationRender() {
  clearTimeout(stationRenderTimer);
  stationRenderTimer = setTimeout(renderStationMarkers, 80);
}

function clearPolylines() {
  // Remove any existing route layers
  map.eachLayer(layer => {
    if (layer instanceof L.Polyline && layer.options && layer.options.color === '#ff9800') {
      map.removeLayer(layer);
    }
  });
}

function exitRouteFocus() {
  routeFocusActive = false;
  clearPolylines();
  clearPinnedStationMarkers();
  renderStationMarkers();
}

function drawItinerary(itin) {
  const polylinePoints = [];
  itin.segments.forEach(seg => {
    const routePoints = Array.isArray(seg.route_points) && seg.route_points.length >= 2
      ? seg.route_points
      : [
          stations.find(s => s.id === seg.from_station_id),
          stations.find(s => s.id === seg.to_station_id)
        ].filter(Boolean);

    routePoints.forEach(point => {
      selectedStationIds.add(point.id);
      createStationMarker(point, {
        radius: point.id === seg.from_station_id || point.id === seg.to_station_id ? 7 : 4,
        color: point.id === seg.from_station_id || point.id === seg.to_station_id ? '#ff9800' : '#00b894'
      });
      polylinePoints.push([point.lat, point.lng]);
    });

  });
  const line = L.polyline(polylinePoints, { color: '#ff9800', weight: 4, opacity: 0.7 }).addTo(map);
  line.setStyle({ dashArray: '5, 10' });
  // Animate dash offset
  let offset = 0;
  const animate = () => {
    offset = (offset + 1) % 15;
    line.setStyle({ dashOffset: `${offset}` });
    requestAnimationFrame(animate);
  };
  animate();
}

function renderResults(itineraries) {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = '';
  clearPolylines();
  clearPinnedStationMarkers();
  if (itineraries.length === 0) {
    routeFocusActive = false;
    renderStationMarkers();
    resultsDiv.innerHTML = '<div class="result-card"><h3>No routes found</h3><p>Checking nearby interchange stations...</p></div>';
    return;
  }
  routeFocusActive = true;
  dynamicStationLayer.clearLayers();
  itineraries.forEach((itin, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const heading = document.createElement('h3');
    heading.textContent = `Option ${idx + 1} - ${itin.total_transfers} transfer(s)`;
    card.appendChild(heading);

    const summary = document.createElement('p');
    summary.className = 'route-summary';
    const arrivalDay = formatDayOffset(itin.final_arrival_day_offset);
    summary.textContent = `Total journey time: ${formatDuration(itin.total_duration_minutes)}${arrivalDay ? `, arrives ${arrivalDay}` : ''}`;
    card.appendChild(summary);

    itin.segments.forEach(seg => {
      const p = document.createElement('p');
      const legArrivalDay = formatDayOffset(seg.arrival_day_offset - seg.departure_day_offset);
      p.textContent = `${seg.train_name}: ${seg.from_station_name} (${seg.departure_time}) -> ${seg.to_station_name} (${seg.arrival_time}${legArrivalDay ? `, ${legArrivalDay}` : ''}) - ${formatDuration(seg.duration_minutes)}`;
      card.appendChild(p);
    });

    const firstSegment = itin.segments[0];
    if (firstSegment) {
      const trackButton = document.createElement('button');
      trackButton.type = 'button';
      trackButton.className = 'track-live-btn';
      trackButton.textContent = `Track ${firstSegment.train_id}`;
      trackButton.addEventListener('click', () => {
        startLiveTracking(firstSegment.train_id, firstSegment.train_name);
      });
      card.appendChild(trackButton);
    }

    resultsDiv.appendChild(card);
    drawItinerary(itin);
  });
  renderStationMarkers();
}

function segmentLabel(seg) {
  const legArrivalDay = formatDayOffset(seg.arrival_day_offset - seg.departure_day_offset);
  return `${seg.train_name}: ${seg.from_station_name} (${seg.departure_time}) -> ${seg.to_station_name} (${seg.arrival_time}${legArrivalDay ? `, ${legArrivalDay}` : ''}) - ${formatDuration(seg.duration_minutes)}`;
}

function renderRouteSuggestions(suggestions, source, dest, date) {
  const resultsDiv = document.getElementById('results');

  if (!suggestions.length) {
    resultsDiv.innerHTML = `
      <div class="result-card">
        <h3>No routes found</h3>
        <p>No nearby interchange suggestion was found online right now. Try a bigger nearby station like TCR, ERS, CBE, SBC, or MYS.</p>
      </div>
    `;
    return;
  }

  routeFocusActive = true;
  dynamicStationLayer.clearLayers();
  clearPinnedStationMarkers();

  resultsDiv.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'result-card suggestion-intro';
  intro.innerHTML = '<h3>No direct route found</h3><p>Try one of these nearby interchange stations first.</p>';
  resultsDiv.appendChild(intro);

  suggestions.forEach((suggestion, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card suggestion-card';

    const bestAccess = suggestion.access_options?.[0];
    const bestOnward = suggestion.onward_options?.[0];
    const totalDuration = suggestion.total_duration_minutes
      ? `Approx train time after confirmed legs: ${formatDuration(suggestion.total_duration_minutes)}`
      : `Reach ${suggestion.hub.name} first, then continue by train`;

    const heading = document.createElement('h3');
    heading.textContent = `Suggestion ${idx + 1}: go via ${suggestion.hub.name} (${suggestion.hub.id})`;
    card.appendChild(heading);

    const summary = document.createElement('p');
    summary.className = 'route-summary';
    summary.textContent = `${Math.round(suggestion.distance_from_source_km)} km from your start station. ${totalDuration}.`;
    card.appendChild(summary);

    const access = document.createElement('p');
    access.textContent = bestAccess
      ? `First leg: ${segmentLabel(bestAccess.segments[0])}`
      : `First leg: ${suggestion.access_note}`;
    card.appendChild(access);

    if (bestOnward) {
      const onward = document.createElement('p');
      onward.textContent = `Then: ${segmentLabel(bestOnward.segments[0])}`;
      card.appendChild(onward);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-btn';
    button.textContent = `Search ${suggestion.hub.id} -> ${dest}`;
    button.addEventListener('click', () => {
      const hubStation = stations.find(st => st.id === suggestion.hub.id) || suggestion.hub;
      const startInput = document.getElementById('startStationSearch');
      const startHidden = document.getElementById('startStation');
      const startSuggestions = document.getElementById('startStationSuggestions');
      setStationSelection(startInput, startHidden, startSuggestions, hubStation);
      searchRoutes(suggestion.hub.id, dest, date);
    });
    card.appendChild(button);

    resultsDiv.appendChild(card);

    if (bestAccess) drawItinerary(bestAccess);
    if (bestOnward) drawItinerary(bestOnward);
  });

  renderStationMarkers();
}

async function fetchRouteSuggestions(source, dest, date) {
  try {
    const query = new URLSearchParams({ source, destination: dest, date }).toString();
    const res = await fetch(`/api/trains/routes/suggestions?${query}`);
    if (!res.ok) throw new Error('Suggestion request failed');
    const suggestions = await res.json();
    renderRouteSuggestions(suggestions, source, dest, date);
  } catch (e) {
    console.error(e);
    document.getElementById('results').innerHTML = '<div class="result-card"><h3>No routes found</h3><p>Could not load interchange suggestions right now.</p></div>';
  }
}

function formatDuration(totalMinutes) {
  if (!Number.isFinite(totalMinutes)) return '';

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function formatDayOffset(dayOffset) {
  if (!dayOffset) return '';
  if (dayOffset === 1) return 'next day';
  return `day +${dayOffset}`;
}

async function searchRoutes(sourceOverride, destOverride, dateOverride) {
  const source = sourceOverride || resolveStationInput('startStationSearch', 'startStation', 'startStationSuggestions');
  const dest = destOverride || resolveStationInput('endStationSearch', 'endStation', 'endStationSuggestions');
  const date = dateOverride ?? document.getElementById('travelDate').value;
  if (!source || !dest) {
    alert('Select both start and end stations');
    return;
  }
  saveState({ source, destination: dest, date });
  try {
    const query = new URLSearchParams({ source, destination: dest, date }).toString();
    const res = await fetch(`/api/trains/routes?${query}`);
    if (!res.ok) throw new Error('Route request failed');
    const data = await res.json();
    renderResults(data);
    if (data.length === 0) {
      fetchRouteSuggestions(source, dest, date);
    }
  } catch (e) {
    console.error(e);
    alert('Error fetching routes');
  }
}

document.getElementById('findRouteBtn').addEventListener('click', () => searchRoutes());

// Initial load
loadStationsAndTrains();
map.on('zoomend moveend', scheduleStationRender);

// --- TABS LOGIC ---
const tabRoute = document.getElementById('tabRoute');
const tabLive = document.getElementById('tabLive');
const routePanel = document.getElementById('routePanel');
const livePanel = document.getElementById('livePanel');

tabRoute.addEventListener('click', () => {
  tabRoute.classList.add('active');
  tabLive.classList.remove('active');
  routePanel.style.display = 'block';
  livePanel.style.display = 'none';
  stopLiveTracking();
  document.getElementById('results').style.display = 'block';
});

tabLive.addEventListener('click', () => {
  tabLive.classList.add('active');
  tabRoute.classList.remove('active');
  routePanel.style.display = 'none';
  livePanel.style.display = 'block';
  document.getElementById('results').style.display = 'none';
  exitRouteFocus();
});

// --- LIVE TRACKING LOGIC ---
document.getElementById('trainSelect').addEventListener('change', (e) => {
  stopLiveTracking();
  const trainId = e.target.value;
  if (!trainId) return;

  activeLiveTrainName = e.target.selectedOptions[0]?.dataset.trainName || e.target.selectedOptions[0]?.textContent || '';
  saveState({
    liveTrainId: trainId,
    liveTrainName: activeLiveTrainName,
    liveTrainLabel: e.target.selectedOptions[0]?.textContent || '',
    liveTime: document.getElementById('liveTime').value
  });
  fetchAndShowLiveStatus(trainId);
  liveTrainInterval = setInterval(() => fetchAndShowLiveStatus(trainId), 5000);
});

document.getElementById('liveTime').addEventListener('change', () => {
  const trainId = document.getElementById('trainSelect').value;
  saveState({ liveTime: document.getElementById('liveTime').value });
  if (trainId) fetchAndShowLiveStatus(trainId);
});

function startLiveTracking(trainId, trainName) {
  tabLive.click();
  stopLiveTracking();

  const trainSelect = document.getElementById('trainSelect');
  let option = [...trainSelect.options].find(opt => opt.value === trainId);

  if (!option) {
    option = document.createElement('option');
    option.value = trainId;
    option.textContent = `${trainName} (${trainId})`;
    option.dataset.trainName = trainName;
    trainSelect.appendChild(option);
  }

  trainSelect.value = trainId;
  activeLiveTrainName = trainName;
  saveState({
    liveTrainId: trainId,
    liveTrainName: trainName,
    liveTrainLabel: option.textContent
  });
  fetchAndShowLiveStatus(trainId);
  liveTrainInterval = setInterval(() => fetchAndShowLiveStatus(trainId), 5000);
}

function stopLiveTracking() {
  if (liveTrainInterval) clearInterval(liveTrainInterval);
  if (liveTrainMarker) {
    map.removeLayer(liveTrainMarker);
    liveTrainMarker = null;
  }
  if (liveRouteLine) {
    map.removeLayer(liveRouteLine);
    liveRouteLine = null;
  }
  if (liveSegmentLine) {
    map.removeLayer(liveSegmentLine);
    liveSegmentLine = null;
  }
  clearPinnedStationMarkers();
  document.getElementById('liveStatusText').textContent = "";
  routeFocusActive = false;
  renderStationMarkers();
}

function drawLiveTrainRoute(data) {
  if (!Array.isArray(data.route_points) || data.route_points.length === 0) return;

  routeFocusActive = true;
  dynamicStationLayer.clearLayers();
  clearPinnedStationMarkers();

  const routeLatLngs = data.route_points.map(point => [point.lat, point.lng]);
  data.route_points.forEach(point => {
    createStationMarker({ id: point.id, name: point.name, lat: point.lat, lng: point.lng }, {
      radius: 6,
      color: '#00b894'
    });
  });

  if (!liveRouteLine) {
    liveRouteLine = L.polyline(routeLatLngs, {
      color: '#00b894',
      weight: 4,
      opacity: 0.55,
      dashArray: '8, 10'
    }).addTo(map);
  } else {
    liveRouteLine.setLatLngs(routeLatLngs);
  }

  if (data.previous_station && data.next_station) {
    const segmentLatLngs = [
      [data.previous_station.lat, data.previous_station.lng],
      [data.next_station.lat, data.next_station.lng]
    ];

    if (!liveSegmentLine) {
      liveSegmentLine = L.polyline(segmentLatLngs, {
        color: '#ff3366',
        weight: 6,
        opacity: 0.9
      }).addTo(map);
    } else {
      liveSegmentLine.setLatLngs(segmentLatLngs);
    }
  }
}

function renderLiveStatusText(data) {
  const liveStatusText = document.getElementById('liveStatusText');
  const lines = [data.message];

  if (data.previous_station && data.next_station) {
    lines.push(`${data.previous_station.name} -> ${data.next_station.name}`);
  } else if (data.current_station && data.next_station) {
    lines.push(`Next: ${data.next_station.name}`);
  }

  if (Number.isFinite(data.progress_percent)) {
    lines.push(`${data.progress_percent}% of this section completed`);
  }

  if (data.next_event_time) {
    const nextTime = new Date(data.next_event_time).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    lines.push(`Next event around ${nextTime}`);
  }

  liveStatusText.innerHTML = lines.map(line => `<div>${line}</div>`).join('');
}

function bearingBetween(from, to) {
  if (!from || !to) return 0;

  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const deltaLng = (to.lng - from.lng) * Math.PI / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function updateTrainMarkerRotation(data) {
  if (!liveTrainMarker) return;

  const rotation = bearingBetween(data.previous_station, data.next_station);
  const markerEl = liveTrainMarker.getElement();
  const body = markerEl?.querySelector('.train-marker-body');
  if (body) {
    body.style.transform = `rotate(${rotation - 90}deg)`;
  }
}

async function fetchAndShowLiveStatus(trainId) {
  try {
    const liveTime = document.getElementById('liveTime').value;
    const params = new URLSearchParams();
    if (liveTime) params.set('time', liveTime);
    if (activeLiveTrainName) params.set('trainName', activeLiveTrainName);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`/api/trains/${trainId}/live${query}`);
    const data = await res.json();
    
    if (data.error) {
      document.getElementById('liveStatusText').textContent = data.error;
      return;
    }

    renderLiveStatusText(data);
    drawLiveTrainRoute(data);

    if (data.location) {
      if (!liveTrainMarker) {
        const pulseIcon = L.divIcon({
          className: 'train-marker',
          html: '<span class="train-marker-body"><span class="coach coach-1"></span><span class="coach coach-2"></span><span class="coach coach-3"></span><span class="engine"></span></span>',
          iconSize: [96, 22],
          iconAnchor: [48, 11]
        });
        liveTrainMarker = L.marker([data.location.lat, data.location.lng], { icon: pulseIcon }).addTo(map);
        map.setView([data.location.lat, data.location.lng], Math.max(map.getZoom(), 7));
      } else {
        liveTrainMarker.setLatLng([data.location.lat, data.location.lng]);
      }
      updateTrainMarkerRotation(data);
    }
  } catch (e) {
    console.error(e);
  }
}
