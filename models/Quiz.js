const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['multiple-choice', 'true-false', 'short-answer'],
    default: 'multiple-choice'
  },
  options: [{
    type: String
  }],
  correctAnswer: {
    type: String,
    required: false,
    default: ''
  },
  points: {
    type: Number,
    default: 1
  }
});

const quizSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  questions: [questionSchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdByName: {
    type: String,
    required: true
  },
  isApproved: {
    type: Boolean,
    default: false
  },
  gradeLevel: {
    type: String,
    enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'],
    required: true
  },
  subjects: [{
    type: String,
    enum: ['English', 'Science', 'Math']
  }],
  language: {
    type: String,
    enum: ['English', 'Spanish', 'French', 'Kannada'],
    default: 'English',
    required: true
  },
  questionPaperUrl: {
    type: String,
    default: null
  },
  answerPaperUrl: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Quiz', quizSchema); 