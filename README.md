# Railway Easy Routing

Railway Easy Routing is an interactive Indian railway route finder and timetable-based live tracking web app.

## Features

- Search trains between Indian railway stations using station name or station code.
- Fetch online train options first, with local demo data as fallback.
- Show direct routes, transfer routes, and nearby interchange suggestions when no direct route is found.
- Draw routes on a Leaflet/OpenStreetMap map using station-by-station track points where available.
- Hide unrelated station dots while showing a selected route.
- Simulate live train movement from timetable data with a top-view train marker.
- Save the last searched route and live train in the browser.

## Tech Stack

- Node.js
- TypeScript
- Express
- SQLite with `better-sqlite3`
- Leaflet

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Notes

Live tracking is timetable-based simulation. It is not real GPS/NTES live location data.
