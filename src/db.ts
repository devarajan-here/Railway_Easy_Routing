const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../railway.db');
const db = new Database(dbPath);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL,
      longitude REAL
    );

    CREATE TABLE IF NOT EXISTS trains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      running_days TEXT NOT NULL -- JSON array of days e.g., ["Monday", "Tuesday"]
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      train_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      arrival_time TEXT, -- HH:mm format
      departure_time TEXT, -- HH:mm format
      stop_sequence INTEGER NOT NULL,
      day_offset INTEGER DEFAULT 0, -- 0 for same day as departure, 1 for next day, etc.
      FOREIGN KEY(train_id) REFERENCES trains(id),
      FOREIGN KEY(station_id) REFERENCES stations(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      tour_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_schedules_train_sequence ON schedules (train_id, stop_sequence);
    CREATE INDEX IF NOT EXISTS idx_schedules_station ON schedules (station_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
  `);

  // Seed or refresh data if the old tiny mock database is present.
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM stations');
  const result = countStmt.get() as { count: number };
  const hasDemoStations = db.prepare(`
    SELECT COUNT(*) as count
    FROM stations
    WHERE id IN ('NDLS', 'ADI', 'BCT', 'HWH', 'MAS', 'SBC')
  `).get() as { count: number };

  if (result.count < 1000 || hasDemoStations.count < 6) {
    seedData();
  }

  ensureDemoTrainSchedules();
}

function seedData() {
  const insertStation = db.prepare('INSERT OR REPLACE INTO stations (id, name, latitude, longitude) VALUES (?, ?, ?, ?)');
  const insertTrain = db.prepare('INSERT OR REPLACE INTO trains (id, name, running_days) VALUES (?, ?, ?)');
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (train_id, station_id, arrival_time, departure_time, stop_sequence, day_offset)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.exec(`
      DELETE FROM schedules;
      DELETE FROM trains;
      DELETE FROM stations;
      DELETE FROM sqlite_sequence WHERE name = 'schedules';
    `);

    // 1. Stations (India)
    const stationsDataPath = path.join(__dirname, 'data/stations.json');
    let stationCount = 0;
    if (fs.existsSync(stationsDataPath)) {
      const geojson = JSON.parse(fs.readFileSync(stationsDataPath, 'utf8'));
      for (const feature of geojson.features) {
        if (!feature.geometry || !feature.geometry.coordinates) continue;
        const code = feature.properties.code;
        const name = feature.properties.name || code;
        const lng = feature.geometry.coordinates[0];
        const lat = feature.geometry.coordinates[1];
        try {
           insertStation.run(code, name, lat, lng);
           stationCount++;
        } catch(e) {
           // ignore duplicate codes
        }
      }
    } else {
      console.warn('stations.json not found, skipping massive station seed.');
    }

    if (stationCount === 0) {
      insertStation.run('NDLS', 'NEW DELHI', 28.6429, 77.2191);
      insertStation.run('BCT', 'Mumbai Central', 18.969, 72.8205);
      insertStation.run('HWH', 'HOWRAH JN', 22.5839, 88.3426);
      insertStation.run('MAS', 'CHENNAI CENTRAL', 13.0827, 80.2707);
      insertStation.run('SBC', 'BANGALORE CITY JN', 12.9779, 77.5667);
      insertStation.run('ADI', 'AHMEDABAD JN', 23.0258, 72.6019);
    }

    insertDemoTrainSchedules(insertTrain, insertSchedule);

  })();
  console.log('Database seeded with station data and demo schedules.');
}

function ensureDemoTrainSchedules() {
  const insertTrain = db.prepare('INSERT OR REPLACE INTO trains (id, name, running_days) VALUES (?, ?, ?)');
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (train_id, station_id, arrival_time, departure_time, stop_sequence, day_offset)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM schedules WHERE train_id IN ('T1', 'T2', 'T3', 'T4', 'T5')").run();
    insertDemoTrainSchedules(insertTrain, insertSchedule);
  })();
}

function insertDemoTrainSchedules(
  insertTrain: Database.Statement,
  insertSchedule: Database.Statement
) {
  const allDays = JSON.stringify(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  const weekdays = JSON.stringify(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);

  insertTrain.run('T1', 'Rajdhani Express (Delhi-Mumbai)', allDays);
  insertTrain.run('T2', 'Shatabdi Express (Delhi-Ahmedabad)', weekdays);
  insertTrain.run('T3', 'Coromandel Express (Howrah-Chennai)', allDays);
  insertTrain.run('T4', 'Karnataka Express (Delhi-Bengaluru)', allDays);
  insertTrain.run('T5', 'Mysuru Express (Thrissur-Bengaluru-Mysore)', allDays);

  // T1: Delhi -> Ahmedabad -> Mumbai
  insertSchedule.run('T1', 'NDLS', null, '16:00', 1, 0);
  insertSchedule.run('T1', 'ADI', '04:00', '04:15', 2, 1);
  insertSchedule.run('T1', 'BCT', '08:00', null, 3, 1);

  // T2: Delhi -> Ahmedabad
  insertSchedule.run('T2', 'NDLS', null, '06:00', 1, 0);
  insertSchedule.run('T2', 'ADI', '20:00', null, 2, 0);

  // T3: Howrah -> Chennai
  insertSchedule.run('T3', 'HWH', null, '15:00', 1, 0);
  insertSchedule.run('T3', 'MAS', '17:00', null, 2, 1);

  // T4: Delhi -> Bengaluru
  insertSchedule.run('T4', 'NDLS', null, '21:00', 1, 0);
  insertSchedule.run('T4', 'SBC', '13:00', null, 2, 2);

  // T5: Thrissur -> Bengaluru -> Mysore, with corridor stops for route simulation.
  insertSchedule.run('T5', 'TCR', null, '20:40', 1, 0);
  insertSchedule.run('T5', 'PGT', '22:00', '22:05', 2, 0);
  insertSchedule.run('T5', 'CBE', '23:15', '23:20', 3, 0);
  insertSchedule.run('T5', 'TUP', '00:05', '00:07', 4, 1);
  insertSchedule.run('T5', 'ED', '00:50', '00:55', 5, 1);
  insertSchedule.run('T5', 'SA', '01:45', '01:50', 6, 1);
  insertSchedule.run('T5', 'JTJ', '03:25', '03:27', 7, 1);
  insertSchedule.run('T5', 'KPN', '04:30', '04:32', 8, 1);
  insertSchedule.run('T5', 'BWT', '05:05', '05:07', 9, 1);
  insertSchedule.run('T5', 'KJM', '05:50', '05:52', 10, 1);
  insertSchedule.run('T5', 'BNC', '06:05', '06:07', 11, 1);
  insertSchedule.run('T5', 'SBC', '06:20', '06:25', 12, 1);
  insertSchedule.run('T5', 'KGI', '07:05', '07:07', 13, 1);
  insertSchedule.run('T5', 'MYS', '09:10', null, 14, 1);
}

module.exports = db;
