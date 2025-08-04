const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  questionIndex: {
    type: Number,
    required: true
  },
  selectedAnswer: {
    type: String,
    required: false,
    default: ''
  },
  correctAnswer: {
    type: String,
    required: true
  },
  isCorrect: {
    type: Boolean,
    required: true
  },
  points: {
    type: Number,
    default: 1
  }
});

const quizResultSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  studentName: {
    type: String,
    required: true
  },
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
    required: true
  },
  quizTitle: {
    type: String,
    required: true
  },
  answers: [answerSchema],
  totalQuestions: {
    type: Number,
    required: true
  },
  correctAnswers: {
    type: Number,
    required: true
  },
  totalPoints: {
    type: Number,
    required: true
  },
  score: {
    type: Number,
    required: true
  },
  percentage: {
    type: Number,
    required: true
  },
  timeTaken: {
    type: Number, // in seconds
    default: 0
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['in-progress', 'completed', 'abandoned'],
    default: 'completed'
  }
}, {
  timestamps: true
});

// Index for efficient queries
quizResultSchema.index({ student: 1, quiz: 1 });
quizResultSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.model('QuizResult', quizResultSchema); 