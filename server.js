require('dotenv').config();

const express = require('express');
const emailService = require('./emailService');
const emailDashboard = require('./emailDashboard');
const initialize = require('./initializeServices');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

(async () => {
    await initialize();
    const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`;
    await emailService.setupGmailPushNotifications(topicName);
})();

// Endpoint to send an email
app.post('/send-email', async (req, res) => {
    const { to, subject, text } = req.body;
    try {
        await emailService.sendMail(to, subject, text);
        res.status(200).send('Email sent successfully');
    } catch (error) {
        res.status(500).send('Error sending email. ' + error);
    }
});

app.post('/gmail/webhook', async (req, res) => {
    try {
        console.log("Gmail webhook triggered");
        
        // Log the incoming request body for debugging
        console.log('Incoming request body:', req.body);

        // Extract and decode the notification data
        const message = req.body.message;
        if (!message || !message.data) {
            throw new Error('Invalid webhook payload');
        }

        // Decode base64url-encoded data
        console.log('Message Data:', message.data)
        const decodedData = Buffer.from(message.data, 'base64').toString();
        const notification = JSON.parse(decodedData); // This line may throw an error if the JSON is invalid
        
        await emailService.handleNewEmail(notification);
        
        // Acknowledge the notification with 200 response
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error processing webhook: ' + error.message);
    }
}); 

// Endpoint to read emails
app.get('/read-emails', async (req, res) => {
    try {
        const emails = await emailService.readEmails();
        res.status(200).json(emails);
    } catch (error) {
        res.status(500).send('Error reading emails. ' + error);
    }
});

// Endpoint to start email service for a user
app.post('/start-email-service', (req, res) => {
    const { userEmail } = req.body;
    if (!userEmail) {
        return res.status(400).send('User email is required');
    }
    emailService.startEmailServiceForUser(userEmail);
    res.status(200).send(`Email service started for ${userEmail}`);
});

// Endpoint to stop email service for a user
app.post('/stop-email-service', (req, res) => {
    const { userEmail } = req.body;
    if (!userEmail) {
        return res.status(400).send('User email is required');
    }
    emailService.stopEmailServiceForUser(userEmail);
    res.status(200).send(`Email service stopped for ${userEmail}`);
});

// Endpoint to stop all email services
app.post('/stop-all-email-services', (req, res) => {
    emailService.stopAllEmailServices();
    res.status(200).send('All email services stopped');
});

// Mount the email dashboard
app.use('/dashboard', emailDashboard);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
}); 