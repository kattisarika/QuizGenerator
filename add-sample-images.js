// Script to add sample PDF images directly to MongoDB
// Run this with: node add-sample-images.js

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/quiz-app');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Quiz schema (simplified)
const quizSchema = new mongoose.Schema({
  title: String,
  description: String,
  pdfImages: [{
    page: { type: Number, required: true },
    imageIndex: { type: Number, required: true },
    s3Key: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    originalName: { type: String, default: null },
    source: { type: String, enum: ['pdf', 'docx', 'doc'], default: 'pdf' },
    isIndividualPage: { type: Boolean, default: false },
    pageNumber: { type: Number, default: null },
    totalPages: { type: Number, default: null }
  }]
}, { strict: false }); // Allow other fields

const Quiz = mongoose.model('Quiz', quizSchema);

// Sample PDF images data
const sampleImages = [
  {
    page: 1,
    imageIndex: 1,
    s3Key: 'quiz-images/sample_quiz_page_1.pdf',
    width: 612,
    height: 792,
    originalName: 'sample_quiz_page_1.pdf',
    source: 'pdf',
    isIndividualPage: true,
    pageNumber: 1,
    totalPages: 3
  },
  {
    page: 2,
    imageIndex: 1,
    s3Key: 'quiz-images/sample_quiz_page_2.pdf',
    width: 612,
    height: 792,
    originalName: 'sample_quiz_page_2.pdf',
    source: 'pdf',
    isIndividualPage: true,
    pageNumber: 2,
    totalPages: 3
  },
  {
    page: 3,
    imageIndex: 1,
    s3Key: 'quiz-images/sample_quiz_page_3.pdf',
    width: 612,
    height: 792,
    originalName: 'sample_quiz_page_3.pdf',
    source: 'pdf',
    isIndividualPage: true,
    pageNumber: 3,
    totalPages: 3
  }
];

// Function to add images to a specific quiz
async function addImagesToQuiz(quizId) {
  try {
    console.log(`🔍 Looking for quiz with ID: ${quizId}`);
    
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      console.log('❌ Quiz not found');
      return;
    }
    
    console.log(`✅ Found quiz: "${quiz.title}"`);
    console.log(`📊 Current PDF images count: ${quiz.pdfImages ? quiz.pdfImages.length : 0}`);
    
    // Add sample images
    quiz.pdfImages = sampleImages;
    
    await quiz.save();
    
    console.log(`✅ Successfully added ${sampleImages.length} PDF images to quiz`);
    console.log('📸 Images added:');
    sampleImages.forEach((img, index) => {
      console.log(`  ${index + 1}. Page ${img.page}: ${img.s3Key}`);
    });
    
  } catch (error) {
    console.error('❌ Error adding images:', error);
  }
}

// Function to add images to the most recent quiz
async function addImagesToLatestQuiz() {
  try {
    console.log('🔍 Looking for the most recent quiz...');
    
    const quiz = await Quiz.findOne().sort({ _id: -1 });
    if (!quiz) {
      console.log('❌ No quizzes found');
      return;
    }
    
    console.log(`✅ Found latest quiz: "${quiz.title}" (ID: ${quiz._id})`);
    console.log(`📊 Current PDF images count: ${quiz.pdfImages ? quiz.pdfImages.length : 0}`);
    
    // Add sample images
    quiz.pdfImages = sampleImages;
    
    await quiz.save();
    
    console.log(`✅ Successfully added ${sampleImages.length} PDF images to latest quiz`);
    console.log('📸 Images added:');
    sampleImages.forEach((img, index) => {
      console.log(`  ${index + 1}. Page ${img.page}: ${img.s3Key}`);
    });
    
  } catch (error) {
    console.error('❌ Error adding images:', error);
  }
}

// Function to list all quizzes
async function listQuizzes() {
  try {
    const quizzes = await Quiz.find({}, { title: 1, pdfImages: 1, createdAt: 1 }).sort({ _id: -1 }).limit(10);
    
    console.log('📋 Recent quizzes:');
    quizzes.forEach((quiz, index) => {
      const imageCount = quiz.pdfImages ? quiz.pdfImages.length : 0;
      console.log(`  ${index + 1}. ${quiz.title} (ID: ${quiz._id}) - ${imageCount} images`);
    });
    
  } catch (error) {
    console.error('❌ Error listing quizzes:', error);
  }
}

// Main function
async function main() {
  await connectDB();
  
  const args = process.argv.slice(2);
  const command = args[0];
  const quizId = args[1];
  
  if (command === 'list') {
    await listQuizzes();
  } else if (command === 'add' && quizId) {
    await addImagesToQuiz(quizId);
  } else if (command === 'latest') {
    await addImagesToLatestQuiz();
  } else {
    console.log('📖 Usage:');
    console.log('  node add-sample-images.js list                    # List recent quizzes');
    console.log('  node add-sample-images.js add <quiz_id>          # Add images to specific quiz');
    console.log('  node add-sample-images.js latest                 # Add images to latest quiz');
  }
  
  mongoose.connection.close();
}

main().catch(console.error);
