const express = require('express');
const { Queue, Worker } = require('bullmq');
const chrono = require('chrono-node');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const reminderQueue = new Queue('reminders', { connection: { host: 'redis' } });

app.post(‘/sms’, async (req, res) => {
  const incomingSms = req.body.Body.trim();
  const sender = req.body.From;

  // Handle cancel command: "cancel <id>"
  const cancelMatch = incomingSms.match(/^cancel\s+(.+)/i);
  if (cancelMatch) {
    const jobId = cancelMatch[1].trim();
    const job = await reminderQueue.getJob(jobId);
    if (job) {
      await job.remove();
      return res.send(`<Response><Message>Cancelled reminder "${job.data.message.replace(‘REMINDER: ‘, ‘’)}".</Message></Response>`);
    }
    return res.send(`<Response><Message>No reminder found with ID ${jobId}.</Message></Response>`);
  }

  // FORMAT "Pick up dry cleaning : 5pm"
  const [task, timeStr] = incomingSms.split(‘:’).map(s => s.trim());

  // Try parsing as-is, then with "in " prefix for bare durations like "10 minutes"
  const targetDate = chrono.parseDate(timeStr || "in 1 hour")
    || chrono.parseDate(`in ${timeStr}`);

  if (!targetDate) {
    return res.send(‘<Response><Message>I couldn\’t figure out that time. Try "5pm" or "in 2 hours".</Message></Response>’);
  }

  const delay = targetDate.getTime() - Date.now();

  // Schedule the job in Redis
  const job = await reminderQueue.add(‘send-reminder’, {
    to: sender,
    message: `REMINDER: ${task}`
  }, { delay: delay });

  res.send(`<Response><Message>Got it. I’ll remind you about "${task}" at ${targetDate.toLocaleTimeString()}. To cancel, text: cancel ${job.id}</Message></Response>`);
});

const worker = new Worker('reminders', async job => {
  await client.messages.create({
    body: job.data.message,
    from: process.env.TWILIO_NUMBER,
    to: job.data.to
  });
}, { connection: { host: 'redis' } });

app.listen(3000, () => console.log('Reminder service online on port 3000'));
