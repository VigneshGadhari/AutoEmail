const { initializeEmailServices } = require('./emailService');

async function initialize() {
  try {
    await initializeEmailServices();
    console.log('Email services initialized successfully');
  } catch (error) {
    console.error('Error initializing services:', error);
  }
}

module.exports = initialize; 