const express = require('express');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { parseCallFlag, parseTime } = require('./parse');

const requiredEnvVars = ['TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_NUMBER', 'REDIS_HOST', 'WEBHOOK_URL'];
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

const emailTransport = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    })
  : null;

// Escape user input for safe inclusion in TwiML XML
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function twiml(message) {
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

function validateCall(call) {
  if (call && !process.env.TWILIO_CALL_NUMBER) {
    return 'Voice calls are not configured. Remove !call and try again.';
  }
  return null;
}

function scheduleJob(sender, task, call, targetDate) {
  const delay = targetDate.getTime() - Date.now();
  if (delay <= 0) return { error: 'That time is in the past. Try a future time like "5pm" or "in 2 hours".' };
  return {
    delay,
    jobData: { to: sender, message: `REMINDER: ${task}`, call },
    jobOpts: { delay, attempts: 3, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } }
  };
}

function confirmationMessage(method, task, targetDate, jobId) {
  return `Got it. I'll ${method} you about "${task}" at ${targetDate.toLocaleTimeString()}. To cancel, text: cancel ${jobId}`;
}

async function handleCancel(sender, incomingSms) {
  const cancelMatch = incomingSms.match(/^cancel\s+(.+)/i);
  if (!cancelMatch) return null;
  const jobId = cancelMatch[1].trim();
  const job = await reminderQueue.getJob(jobId);
  if (job && job.data.to === sender) {
    await job.remove();
    console.log('Cancelled reminder', jobId);
    return twiml(`Cancelled reminder "${job.data.message.replace('REMINDER: ', '')}".`);
  }
  return twiml(`No reminder found with ID ${jobId}.`);
}

async function handlePendingReply(sender, incomingSms) {
  const pendingKey = `pending:${sender}`;
  const pendingTask = await redis.get(pendingKey);
  if (!pendingTask) return null;

  const { text: timeInput, call } = parseCallFlag(incomingSms);
  const callErr = validateCall(call);
  if (callErr) return twiml(callErr);

  const targetDate = parseTime(timeInput);
  if (!targetDate) {
    console.log('Could not parse time for pending task:', incomingSms);
    return twiml('I couldn\'t figure out that time. Try "5pm" or "in 2 hours".');
  }

  const sched = scheduleJob(sender, pendingTask, call, targetDate);
  if (sched.error) return twiml(sched.error);

  const job = await reminderQueue.add('send-reminder', sched.jobData, sched.jobOpts);
  await redis.del(pendingKey);
  const method = call ? 'call' : 'remind';
  console.log('Scheduled reminder', job.id, '- task:', pendingTask, '- at:', targetDate.toISOString(), '- delay:', Math.round(sched.delay / 1000), 's', call ? '(call)' : '');
  return twiml(confirmationMessage(method, pendingTask, targetDate, job.id));
}

async function handleList(sender, incomingSms) {
  if (!/^list$/i.test(incomingSms)) return null;
  const jobs = await reminderQueue.getJobs(['delayed', 'waiting', 'active', 'retry']);
  const userJobs = jobs.filter(j => j.data.to === sender);
  if (userJobs.length === 0) {
    return twiml('You have no upcoming reminders.');
  }
  const lines = userJobs.map(j => {
    const task = j.data.message.replace('REMINDER: ', '');
    const when = new Date(j.timestamp + j.delay).toLocaleString();
    const mode = j.data.call ? ' (call)' : '';
    return `- ${task}${mode} (${when}) [cancel ${j.id}]`;
  });
  return twiml(`Your reminders:\n${lines.join('\n')}`);
}

async function handleNewReminder(sender, incomingSms) {
  const lastColon = incomingSms.lastIndexOf(' : ');
  const task = (lastColon === -1 ? incomingSms : incomingSms.slice(0, lastColon)).trim();
  const timeStr = lastColon === -1 ? null : incomingSms.slice(lastColon + 3).trim() || null;

  if (!task) {
    return twiml('Please include a reminder message. Format: "Pick up dry cleaning : 5pm"');
  }

  if (!timeStr) {
    await redis.set(`pending:${sender}`, task, 'EX', PENDING_TTL);
    console.log('Pending task for', sender, ':', task);
    return twiml(`When should I remind you about "${task}"?`);
  }

  const { text: cleanTime, call } = parseCallFlag(timeStr);
  const callErr = validateCall(call);
  if (callErr) return twiml(callErr);

  const targetDate = parseTime(cleanTime);
  if (!targetDate) {
    console.log('Could not parse time:', timeStr);
    return twiml('I couldn\'t figure out that time. Try "5pm" or "in 2 hours".');
  }

  const sched = scheduleJob(sender, task, call, targetDate);
  if (sched.error) return twiml(sched.error);

  const job = await reminderQueue.add('send-reminder', sched.jobData, sched.jobOpts);
  const method = call ? 'call' : 'remind';
  console.log('Scheduled reminder', job.id, '- task:', task, '- at:', targetDate.toISOString(), '- delay:', Math.round(sched.delay / 1000), 's', call ? '(call)' : '');
  return twiml(confirmationMessage(method, task, targetDate, job.id));
}

app.get('/status', (req, res, next) => {
  if (!process.env.STATUS_PASSWORD) return res.status(403).send('Status endpoint not configured');
  const auth = req.headers.authorization;
  if (!auth || auth !== 'Basic ' + Buffer.from('admin:' + process.env.STATUS_PASSWORD).toString('base64')) {
    res.set('WWW-Authenticate', 'Basic realm="status"');
    return res.status(401).send('Unauthorized');
  }
  next();
}, async (req, res) => {
  const jobs = await reminderQueue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed']);
  res.json(jobs.map(j => ({
    id: j.id,
    to: j.data.to,
    message: j.data.message,
    call: !!j.data.call,
    scheduledFor: new Date(j.timestamp + j.delay).toISOString(),
    state: j.finishedOn ? (j.failedReason ? 'failed' : 'completed') : 'pending'
  })));
});

app.post('/sms', twilio.webhook({ validate: true, url: process.env.WEBHOOK_URL }, process.env.TWILIO_TOKEN), async (req, res) => {
  try {
    console.log('Incoming SMS from', req.body.From, ':', req.body.Body);
    const incomingSms = req.body.Body.trim();
    const sender = req.body.From;

    const response =
      await handleCancel(sender, incomingSms) ||
      await handleList(sender, incomingSms) ||
      await handlePendingReply(sender, incomingSms) ||
      await handleNewReminder(sender, incomingSms);

    res.send(response);
  } catch (err) {
    console.error('Error handling SMS:', err);
    res.status(500).send(twiml('Something went wrong. Please try again.'));
  }
});

const worker = new Worker('reminders', async job => {
  const { to, message, call } = job.data;
  console.log(call ? 'Calling' : 'Texting', job.id, 'to', to, ':', message);
  if (call) {
    await client.calls.create({
      to,
      from: process.env.TWILIO_CALL_NUMBER,
      twiml: `<Response><Say>${escapeXml(message)}</Say></Response>`
    });
  } else {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_NUMBER,
      to
    });
  }
  console.log('Reminder', job.id, 'sent successfully');
}, { connection: redisConnection });

worker.on('failed', async (job, err) => {
  console.error('Job', job?.id, 'failed (attempt', `${job?.attemptsMade}/${job?.opts?.attempts}):`, err.message);
  if (job && job.attemptsMade === job.opts.attempts && emailTransport && process.env.ALERT_EMAIL_TO) {
    const task = job.data.message.replace('REMINDER: ', '');
    try {
      await emailTransport.sendMail({
        from: process.env.GMAIL_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject: `FAILED REMINDER: ${task}`,
        text: `Your reminder failed after ${job.attemptsMade} attempts.\n\nTask: ${task}\nTo: ${job.data.to}\nScheduled for: ${new Date(job.timestamp + job.delay).toISOString()}\nError: ${err.message}`
      });
      console.log('Fallback email sent for job', job.id);
    } catch (emailErr) {
      console.error('Fallback email also failed for job', job.id, ':', emailErr.message);
    }
  }
});

app.listen(3000, () => console.log('Reminder service online on port 3000'));
