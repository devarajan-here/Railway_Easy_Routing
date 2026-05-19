import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import stationRoutes from './routes/stationRoutes';
import trainRoutes from './routes/trainRoutes';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Database
initDb();

// Serve static frontend files
app.use(express.static('public'));


// Routes
app.use('/api/stations', stationRoutes);
app.use('/api/trains', trainRoutes); // Includes routing logic

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Railway Routing Backend listening on port ${PORT}`);
});
