const express = require('express');
const router = express.Router();
const { getEmailLogs } = require('./emailService');

// Serve the dashboard HTML
router.get('/', (req, res) => {
  res.sendFile(__dirname+'/index.html');
});

// API endpoint to get email logs
router.get('/api/email-logs', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }

  const logs = await getEmailLogs(email);
  res.json(logs);
});

module.exports = router; 