const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const stationRoutes = require('./routes/stationRoutes');
const trainRoutes = require('./routes/trainRoutes');
const placeRoutes = require('./routes/placeRoutes');
const trackRoutes = require('./routes/trackRoutes');
const authRoutes = require('./routes/authRoutes');

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
