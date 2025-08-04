const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/take_quiz_now')
.then(() => {
  console.log('✅ MongoDB connected successfully!');
  console.log('📊 Database setup complete!');
  console.log('🚀 You can now start the server with: npm start');
  process.exit(0);
})
.catch((err) => {
  console.error('❌ MongoDB connection error:', err);
  console.log('💡 Make sure MongoDB is running on your system');
  console.log('📖 To install MongoDB: https://docs.mongodb.com/manual/installation/');
  process.exit(1);
}); 