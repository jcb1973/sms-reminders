const express = require('express');
const { Queue, Worker } = require('bullmq');
const chrono = require('chrono-node');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const reminderQueue = new Queue('reminders', { connection: { host: 'redis' } });

// 1. RECEIVE THE SMS
app.post('/sms', async (req, res) => {
  const incomingSms = req.body.Body; // e.g. "Pick up dry cleaning : 5pm"
  const sender = req.body.From;

  const [task, timeStr] = incomingSms.split(':').map(s => s.trim());
  const targetDate = chrono.parseDate(timeStr || "in 1 hour");

  if (!targetDate) {
    return res.send('<Response><Message>I couldn’t figure out that time. Try "5pm" or "in 2 hours".</Message></Response>');
  }

  const delay = targetDate.getTime() - Date.now();

  // Schedule the job in the FOSS queue (Redis)
  await reminderQueue.add('send-reminder', { 
    to: sender, 
    message: `⏰ REMINDER: ${task}` 
  }, { delay: delay });

  res.send(`<Response><Message>Got it. I'll remind you about "${task}" at ${targetDate.toLocaleTimeString()}.</Message></Response>`);
});

// 2. THE WORKER (The part that actually sends the reminder)
const worker = new Worker('reminders', async job => {
  await client.messages.create({
    body: job.data.message,
    from: process.env.TWILIO_NUMBER,
    to: job.data.to
  });
}, { connection: { host: 'redis' } });

app.listen(3000, () => console.log('Reminder service online on port 3000'));
