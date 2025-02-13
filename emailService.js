const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { Client } = require('@elastic/elasticsearch');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const cron = require('node-cron');

// Replace the hardcoded credentials section with:
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLEINT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLEINT_SECRET,
  REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

// Initialize Elasticsearch client
const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  auth: {
    username: process.env.ELASTICSEARCH_USERNAME,
    password: process.env.ELASTICSEARCH_PASSWORD
  }
});

// Initialize Redis connection
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Initialize email queue
const emailQueue = new Queue('email-queue', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: false, // Keep job history
    attempts: 3, // Retry failed jobs up to 3 times
  }
});

// Replace the emailIntervals Map with a way to track active services
let activeEmailServices = new Set();

// Worker to process emails
const emailWorker = new Worker('email-queue', async (job) => {
  const { userEmail } = job.data;
  try {
    const result = await sendMail(userEmail);
    await logEmailEvent('email_sent_by_worker', {
      userEmail,
      jobId: job.id,
      status: 'success'
    });
    return result;
  } catch (error) {
    await logEmailEvent('email_send_failed_by_worker', {
      userEmail,
      jobId: job.id,
      error: error.message,
      status: 'failed'
    });
    throw error;
  }
}, {
  connection: redis,
});

// Handle worker events
emailWorker.on('completed', (job) => {
  console.log(`Email job ${job.id} completed successfully`);
});

emailWorker.on('failed', (job, error) => {
  console.error(`Email job ${job.id} failed:`, error);
});

// Helper function to log events to Elasticsearch
async function logEmailEvent(eventType, data) {
  try {
    await esClient.index({
      index: 'email-logs',
      document: {
        timestamp: new Date(),
        eventType,
        ...data
      }
    });
  } catch (error) {
    console.error('Error logging to Elasticsearch:', error);
  }
}

async function sendMail(email) {
  try {
    const accessToken = await oAuth2Client.getAccessToken();

    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
        accessToken: accessToken,
      },
    });

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: 'Hello from gmail using API',
      text: 'Hello from gmail email using API',
      html: '<h1>Hello from gmail email using API</h1>',
    };

    const result = await transport.sendMail(mailOptions);
    
    // Log successful email sending
    await logEmailEvent('email_sent', {
      recipient: email,
      messageId: result.messageId,
      status: 'success'
    });
    
    return result;
  } catch (error) {
    // Log failed email sending
    await logEmailEvent('email_send_failed', {
      recipient: email,
      error: error.message,
      status: 'failed'
    });
    return error;
  }
}

async function readEmails() {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10, // Adjust the number of emails to retrieve
    });

    const messages = res.data.messages || [];
    const emailPromises = messages.map(async (message) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
      });
      return msg.data;
    });

    const emails = await Promise.all(emailPromises);
    return emails;
  } catch (error) {
    return error;
  }
}

async function setupGmailPushNotifications(topicName) {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    
    // First, create a Cloud Pub/Sub topic if you haven't already
    // The topic should be in format: projects/{project-id}/topics/{topic-name}
    
    // Watch for new messages
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: topicName,
        labelIds: ['INBOX']
      }
    });
    
    console.log('Gmail push notifications set up:', res.data);
    return res.data;
  } catch (error) {
    console.error('Error setting up push notifications:', error);
    throw error;
  }
}

async function stopGmailPushNotifications() {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const res = await gmail.users.stop({
      userId: 'me'
    });
    console.log('Gmail push notifications stopped');
    return res.data;
  } catch (error) {
    console.error('Error stopping push notifications:', error);
    throw error;
  }
}

async function startEmailServiceForUser(userEmail) {
  if (activeEmailServices.has(userEmail)) {
    console.log(`Email service already running for ${userEmail}`);
    await logEmailEvent('email_service_start_skipped', {
      userEmail,
      reason: 'Service already running'
    });
    return;
  }

  try {
    // Add recurring job
    await emailQueue.add(
      `email-service-${userEmail}`,
      { userEmail },
      {
        repeat: {
          every: 60000, // 60 seconds
        },
        jobId: `recurring-${userEmail}`, // Unique job ID for this user
      }
    );

    activeEmailServices.add(userEmail);
    await logEmailEvent('email_service_started', {
      userEmail,
      intervalMs: 60000
    });
    
    console.log(`Email service started for ${userEmail}`);
  } catch (error) {
    console.error(`Error starting email service for ${userEmail}:`, error);
    await logEmailEvent('email_service_start_failed', {
      userEmail,
      error: error.message
    });
  }
}

async function stopEmailServiceForUser(userEmail) {
  try {
    const repeatableJobs = await emailQueue.getRepeatableJobs();
    const userJob = repeatableJobs.find(job => job.id === `recurring-${userEmail}`);
    
    if (userJob) {
      await emailQueue.removeRepeatableByKey(userJob.key);
      activeEmailServices.delete(userEmail);
      await logEmailEvent('email_service_stopped', {
        userEmail,
        reason: 'Manual stop'
      });
      console.log(`Email service stopped for ${userEmail}`);
    } else {
      await logEmailEvent('email_service_stop_skipped', {
        userEmail,
        reason: 'No service running'
      });
      console.log(`No email service running for ${userEmail}`);
    }
  } catch (error) {
    console.error(`Error stopping email service for ${userEmail}:`, error);
    await logEmailEvent('email_service_stop_failed', {
      userEmail,
      error: error.message
    });
  }
}

async function stopAllEmailServices() {
  try {
    const repeatableJobs = await emailQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await emailQueue.removeRepeatableByKey(job.key);
    }
    activeEmailServices.clear();
    console.log('All email services stopped');
  } catch (error) {
    console.error('Error stopping all email services:', error);
  }
}

// Modify the initializeEmailServices function to also set up the watch renewal
async function initializeEmailServices() {
    try {
        // Restore active services
        const repeatableJobs = await emailQueue.getRepeatableJobs();
        repeatableJobs.forEach(job => {
            const userEmail = job.id.replace('recurring-', '');
            activeEmailServices.add(userEmail);
            console.log(`Restored email service for ${userEmail}`);
        });

        // Set up daily renewal of Gmail watch
        cron.schedule('0 0 * * *', async () => {  // Runs at midnight every day
            try {
                await renewGmailWatch();
                console.log('Gmail watch renewed successfully');
            } catch (error) {
                console.error('Failed to renew Gmail watch:', error);
            }
        });

        // Initial watch setup
        await renewGmailWatch();
        console.log('Initial Gmail watch setup completed');
    } catch (error) {
        console.error('Error initializing email services:', error);
    }
}

// This function would be called by your webhook endpoint
async function handleNewEmail(notification) {
    try {
        const { emailAddress, historyId } = notification;
        
        // Get changes since this historyId
        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
        const history = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: historyId,
            labelId: 'INBOX'
        });

        if (!history.data.history) {
            console.log('No new changes found');
            return;
        }

        // Process each history record
        for (const record of history.data.history) {
            // Handle messages added to inbox
            if (record.messagesAdded) {
                for (const message of record.messagesAdded) {
                    const email = await gmail.users.messages.get({
                        userId: 'me',
                        id: message.message.id
                    });

                    const headers = email.data.payload.headers;
                    const fromHeader = headers.find(header => header.name === 'From');
                    const fromEmail = fromHeader ? (fromHeader.value.match(/<(.+)>/)?.[1] || fromHeader.value) : null;
                    const subjectHeader = headers.find(header => header.name === 'Subject');

                    await logEmailEvent('email_received', {
                        from: fromEmail,
                        subject: subjectHeader?.value,
                        messageId: message.message.id,
                        historyId
                    });

                    // If this is from someone with an active email service, stop it
                    if (fromEmail && activeEmailServices.has(fromEmail)) {
                        await stopEmailServiceForUser(fromEmail);
                        await logEmailEvent('email_service_stopped', {
                            userEmail: fromEmail,
                            reason: 'Response received'
                        });
                    }
                }
            }
        }
    } catch (error) {
        await logEmailEvent('email_processing_error', {
            error: error.message,
            historyId: notification.historyId
        });
        console.error('Error handling new email:', error);
        throw error;
    }
}

// Add function to retrieve logs for a specific email
async function getEmailLogs(email) {
  try {
    const result = await esClient.search({
      index: 'email-logs',
      body: {
        query: {
          bool: {
            should: [
              { match: { recipient: email } },
              { match: { from: email } },
              { match: { userEmail: email } }
            ]
          }
        },
        sort: [
          { timestamp: { order: 'desc' } }
        ]
      }
    });

    return result.hits.hits.map(hit => hit._source);
  } catch (error) {
    console.error('Error retrieving email logs:', error);
    return [];
  }
}

async function renewGmailWatch() {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
        const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`;
        
        const response = await gmail.users.watch({
            userId: 'me',
            requestBody: {
                topicName: topicName,
                labelIds: ['INBOX'],
                labelFilterBehavior: 'INCLUDE'
            }
        });
        
        await logEmailEvent('gmail_watch_renewed', {
            historyId: response.data.historyId,
            expiration: response.data.expiration
        });
        
        return response.data;
    } catch (error) {
        console.error('Error renewing Gmail watch:', error);
        await logEmailEvent('gmail_watch_renewal_failed', {
            error: error.message
        });
        throw error;
    }
}

module.exports = {
  sendMail,
  readEmails,
  startEmailServiceForUser,
  stopEmailServiceForUser,
  stopAllEmailServices,
  setupGmailPushNotifications,
  stopGmailPushNotifications,
  handleNewEmail,
  getEmailLogs,
  initializeEmailServices,
  renewGmailWatch
}