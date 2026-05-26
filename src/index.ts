import express from 'express';
import cors from 'cors';
import { initDb } from './db.ts';
import stationRoutes from './routes/stationRoutes.ts';
import trainRoutes from './routes/trainRoutes.ts';
import placeRoutes from './routes/placeRoutes.ts';
import trackRoutes from './routes/trackRoutes.ts';
import authRoutes from './routes/authRoutes.ts';

const app = express();
const PORT = process.env.DEV_PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Database
try {
  initDb();
} catch (err: any) {
  console.error('DB init error:', err?.message);
  process.exit(1);
}

// Serve static frontend files
app.use(express.static('public'));


// Routes
app.use('/api/auth', authRoutes);
app.use('/api/stations', stationRoutes);
app.use('/api/trains', trainRoutes); // Includes routing logic
app.use('/api/places', placeRoutes);
app.use('/api/tracks', trackRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(PORT, () => {
  console.log(`Railway Routing Backend listening on port ${PORT}`);
});

process.on('uncaughtException', (err: any) => {
  console.error('Uncaught Exception:', err?.message || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
  process.exit(1);
});
