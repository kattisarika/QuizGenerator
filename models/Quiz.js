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
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  isApproved: {
    type: Boolean,
    default: true  // Auto-approve all quizzes
  },
  quizType: {
    type: String,
    enum: ['regular', 'competitive'],
    default: 'regular'
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
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for SaaS multi-tenancy
quizSchema.index({ organizationId: 1, createdBy: 1 });
quizSchema.index({ organizationId: 1, gradeLevel: 1 });
quizSchema.index({ organizationId: 1, isApproved: 1 });
quizSchema.index({ organizationId: 1, subjects: 1 });
quizSchema.index({ organizationId: 1, language: 1 });

// Pre-save middleware
quizSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static method to find quizzes by organization
quizSchema.statics.findByOrganization = function(organizationId, filter = {}) {
  return this.find({ organizationId, ...filter });
};

// Static method to find approved quizzes for students
quizSchema.statics.findApprovedForOrganization = function(organizationId, gradeLevel = null, subjects = null) {
  const filter = { organizationId, isApproved: true };
  if (gradeLevel) filter.gradeLevel = gradeLevel;
  if (subjects && subjects.length > 0) filter.subjects = { $in: subjects };
  return this.find(filter);
};

module.exports = mongoose.model('Quiz', quizSchema); 