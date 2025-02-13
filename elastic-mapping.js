const mapping = {
  mappings: {
    properties: {
      timestamp: { type: 'date' },
      eventType: { type: 'keyword' },
      recipient: { type: 'keyword' },
      from: { type: 'keyword' },
      userEmail: { type: 'keyword' },
      messageId: { type: 'keyword' },
      status: { type: 'keyword' },
      subject: { type: 'text' },
      error: { type: 'text' },
      reason: { type: 'text' },
      intervalMs: { type: 'long' }
    }
  }
};

async function createIndex() {
  try {
    const { Client } = require('@elastic/elasticsearch');
    const client = new Client({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200' });
    
    await client.indices.create({
      index: 'email-logs',
      body: mapping
    });
    
    console.log('Email logs index created successfully');
  } catch (error) {
    console.error('Error creating email logs index:', error);
  }
}

module.exports = { createIndex }; 