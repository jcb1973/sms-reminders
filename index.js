const express = require('express');
const { Queue, Worker } = require('bullmq');
const chrono = require('chrono-node');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const reminderQueue = new Queue('reminders', { connection: { host: 'redis' } });
const pendingTasks = new Map(); // phone -> task awaiting a time

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

app.post('/sms', twilio.webhook({ validate: !!process.env.TWILIO_TOKEN }), async (req, res) => {
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
  if (pendingTasks.has(sender)) {
    const task = pendingTasks.get(sender);
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
    pendingTasks.delete(sender);
    const job = await reminderQueue.add('send-reminder', {
      to: sender,
      message: `REMINDER: ${task}`
    }, { delay: delay });
    console.log('Scheduled reminder', job.id, '- task:', task, '- at:', targetDate.toISOString(), '- delay:', Math.round(delay / 1000), 's');
    return res.send(twiml(`Got it. I'll remind you about "${task}" at ${targetDate.toLocaleTimeString()}. To cancel, text: cancel ${job.id}`));
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
    pendingTasks.set(sender, task);
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
  }, { delay: delay });

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
}, { connection: { host: 'redis' } });

app.listen(3000, () => console.log('Reminder service online on port 3000'));
