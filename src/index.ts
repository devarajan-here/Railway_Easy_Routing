import express from 'express';
import cors from 'cors';
import { initDb } from './db.ts';
import stationRoutes from './routes/stationRoutes.ts';
import trainRoutes from './routes/trainRoutes.ts';
import placeRoutes from './routes/placeRoutes.ts';
import trackRoutes from './routes/trackRoutes.ts';
import authRoutes from './routes/authRoutes.ts';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Database
initDb();

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

app.listen(PORT, () => {
  console.log(`Railway Routing Backend listening on port ${PORT}`);
});
