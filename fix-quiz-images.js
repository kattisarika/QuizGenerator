// Quick script to add images to the specific quiz
// Run with: node fix-quiz-images.js

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || process.env.DATABASE_URL);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Simple quiz schema
const quizSchema = new mongoose.Schema({}, { strict: false });
const Quiz = mongoose.model('Quiz', quizSchema);

async function fixQuizImages() {
  try {
    const quizId = '68a6a685e55d3088ef4abc14'; // Updated to current quiz ID
    
    console.log(`🔍 Looking for quiz: ${quizId}`);
    
    // Check if quiz exists
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      console.log('❌ Quiz not found!');
      return;
    }
    
    console.log(`✅ Found quiz: "${quiz.title}"`);
    console.log(`📊 Current pdfImages: ${quiz.pdfImages ? quiz.pdfImages.length : 0} images`);
    
    // Add sample images
    const sampleImages = [
      {
        url: "https://via.placeholder.com/600x800/4f46e5/ffffff?text=Quiz+Page+1",
        title: "Quiz Page 1",
        description: "Sample quiz page 1 - Math Problems",
        type: "image",
        source: "pdf",
        order: 1
      },
      {
        url: "https://via.placeholder.com/600x800/059669/ffffff?text=Quiz+Page+2",
        title: "Quiz Page 2",
        description: "Sample quiz page 2 - Science Questions",
        type: "image",
        source: "pdf",
        order: 2
      },
      {
        url: "https://via.placeholder.com/600x800/dc2626/ffffff?text=Quiz+Page+3",
        title: "Quiz Page 3", 
        description: "Sample quiz page 3 - Answer Sheet",
        type: "image",
        source: "pdf",
        order: 3
      }
    ];
    
    // Update the quiz
    const result = await Quiz.updateOne(
      { _id: quizId },
      { $set: { pdfImages: sampleImages } }
    );
    
    if (result.modifiedCount > 0) {
      console.log('✅ Successfully added images to quiz!');
      console.log('📸 Added 3 sample images:');
      sampleImages.forEach((img, index) => {
        console.log(`  ${index + 1}. ${img.title}: ${img.url}`);
      });

      // Verify the update with detailed logging
      const updatedQuiz = await Quiz.findById(quizId, { title: 1, pdfImages: 1 });
      console.log(`🔍 Verification: Quiz now has ${updatedQuiz.pdfImages ? updatedQuiz.pdfImages.length : 0} images`);

      if (updatedQuiz.pdfImages && updatedQuiz.pdfImages.length > 0) {
        console.log('🔍 First image details:');
        console.log('  - URL:', updatedQuiz.pdfImages[0].url);
        console.log('  - Title:', updatedQuiz.pdfImages[0].title);
        console.log('  - Type:', updatedQuiz.pdfImages[0].type);
        console.log('  - Source:', updatedQuiz.pdfImages[0].source);
        console.log('  - Full object:', JSON.stringify(updatedQuiz.pdfImages[0], null, 2));
      } else {
        console.log('❌ No images found after update!');
      }

    } else {
      console.log('❌ Failed to update quiz - no documents modified');
      console.log('This might mean the quiz ID is incorrect or the quiz doesn\'t exist');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
}

// Run the fix
async function main() {
  await connectDB();
  await fixQuizImages();
}

main().catch(console.error);
