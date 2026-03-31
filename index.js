const express = require('express');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const chrono = require('chrono-node');
const twilio = require('twilio');

const requiredEnvVars = ['TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_NUMBER', 'REDIS_HOST'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const redisConnection = { host: process.env.REDIS_HOST };
const redis = new IORedis(redisConnection);
const reminderQueue = new Queue('reminders', { connection: redisConnection });
const PENDING_TTL = 300; // 5 minutes

// Expand shorthand like "10m", "2h", "30s", "1d" to chrono-friendly strings
function expandTime(str) {
  return str.replace(/(\d+)\s*(s|m|h|d)\b/gi, (_, n, unit) => {
    const units = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
    return `${n} ${units[unit.toLowerCase()]}`;
  });
}

// Escape user input for safe inclusion in TwiML XML
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function twiml(message) {
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

app.post('/sms', twilio.webhook({ validate: true, url: process.env.WEBHOOK_URL }, process.env.TWILIO_TOKEN), async (req, res) => {
  console.log('Incoming SMS from', req.body.From, ':', req.body.Body);
  const incomingSms = req.body.Body.trim();
  const sender = req.body.From;

  // Handle cancel command: "cancel <id>"
  const cancelMatch = incomingSms.match(/^cancel\s+(.+)/i);
  if (cancelMatch) {
    const jobId = cancelMatch[1].trim();
    const job = await reminderQueue.getJob(jobId);
    if (job && job.data.to === sender) {
      await job.remove();
      console.log('Cancelled reminder', jobId);
      return res.send(twiml(`Cancelled reminder "${job.data.message.replace('REMINDER: ', '')}".`));
    }
    return res.send(twiml(`No reminder found with ID ${jobId}.`));
  }

  // If this user has a pending task, treat this message as the time
  const pendingKey = `pending:${sender}`;
  const pendingTask = await redis.get(pendingKey);
  if (pendingTask) {
    const expanded = expandTime(incomingSms);
    const targetDate = chrono.parseDate(expanded) || chrono.parseDate(`in ${expanded}`);
    if (!targetDate) {
      console.log('Could not parse time for pending task:', incomingSms);
      return res.send(twiml('I couldn\'t figure out that time. Try "5pm" or "in 2 hours".'));
    }
    const delay = targetDate.getTime() - Date.now();
    if (delay <= 0) {
      return res.send(twiml('That time is in the past. Try a future time like "5pm" or "in 2 hours".'));
    }
    await redis.del(pendingKey);
    const job = await reminderQueue.add('send-reminder', {
      to: sender,
      message: `REMINDER: ${pendingTask}`
    }, { delay: delay, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } });
    console.log('Scheduled reminder', job.id, '- task:', pendingTask, '- at:', targetDate.toISOString(), '- delay:', Math.round(delay / 1000), 's');
    return res.send(twiml(`Got it. I'll remind you about "${pendingTask}" at ${targetDate.toLocaleTimeString()}. To cancel, text: cancel ${job.id}`));
  }

  // Handle list command
  if (/^list$/i.test(incomingSms)) {
    const jobs = await reminderQueue.getJobs(['delayed']);
    const userJobs = jobs.filter(j => j.data.to === sender);
    if (userJobs.length === 0) {
      return res.send(twiml('You have no upcoming reminders.'));
    }
    const lines = userJobs.map(j => {
      const task = j.data.message.replace('REMINDER: ', '');
      const when = new Date(j.timestamp + j.delay).toLocaleString();
      return `- ${task} (${when}) [cancel ${j.id}]`;
    });
    return res.send(twiml(`Your reminders:\n${lines.join('\n')}`));
  }

  // FORMAT "Pick up dry cleaning : 5pm" or just "Pick up dry cleaning"
  const lastColon = incomingSms.lastIndexOf(':');
  const task = (lastColon === -1 ? incomingSms : incomingSms.slice(0, lastColon)).trim();
  const timeStr = lastColon === -1 ? null : incomingSms.slice(lastColon + 1).trim() || null;

  if (!task) {
    return res.send(twiml('Please include a reminder message. Format: "Pick up dry cleaning : 5pm"'));
  }

  // No time provided — ask for it
  if (!timeStr) {
    await redis.set(`pending:${sender}`, task, 'EX', PENDING_TTL);
    console.log('Pending task for', sender, ':', task);
    return res.send(twiml(`When should I remind you about "${task}"?`));
  }

  // Try parsing as-is, then with "in " prefix for bare durations like "10 minutes"
  const expanded = expandTime(timeStr);
  const targetDate = chrono.parseDate(expanded) || chrono.parseDate(`in ${expanded}`);

  if (!targetDate) {
    console.log('Could not parse time:', timeStr);
    return res.send(twiml('I couldn\'t figure out that time. Try "5pm" or "in 2 hours".'));
  }

  const delay = targetDate.getTime() - Date.now();

  if (delay <= 0) {
    return res.send(twiml('That time is in the past. Try a future time like "5pm" or "in 2 hours".'));
  }

  // Schedule the job in Redis
  const job = await reminderQueue.add('send-reminder', {
    to: sender,
    message: `REMINDER: ${task}`
  }, { delay: delay, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } });

  console.log('Scheduled reminder', job.id, '- task:', task, '- at:', targetDate.toISOString(), '- delay:', Math.round(delay / 1000), 's');
  res.send(twiml(`Got it. I'll remind you about "${task}" at ${targetDate.toLocaleTimeString()}. To cancel, text: cancel ${job.id}`));
});

const worker = new Worker('reminders', async job => {
  console.log('Sending reminder', job.id, 'to', job.data.to, ':', job.data.message);
  await client.messages.create({
    body: job.data.message,
    from: process.env.TWILIO_NUMBER,
    to: job.data.to
  });
  console.log('Reminder', job.id, 'sent successfully');
}, { connection: redisConnection });

app.listen(3000, () => console.log('Reminder service online on port 3000'));
