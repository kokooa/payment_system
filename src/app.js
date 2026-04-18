require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const paymentRouter = require('./routes/payment');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'checkout.html' }));
app.use('/api', paymentRouter);

app.get('/health', async (req, res) => {
  const result = await db.query('SELECT NOW()');
  res.json({ status: 'ok', dbTime: result.rows[0].now });
});

app.get('/api/config', (req, res) => {
  res.json({ tossClientKey: process.env.TOSS_CLIENT_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
