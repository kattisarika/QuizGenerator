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
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    enum: ['in-progress', 'completed', 'abandoned', 'pending-recorrection', 'rechecked'],
    default: 'completed'
  },
  // Recorrection system fields
  recorrectionRequested: {
    type: Boolean,
    default: false
  },
  recorrectionRequestedAt: {
    type: Date,
    default: null
  },
  recorrectionReason: {
    type: String,
    default: ''
  },
  originalScore: {
    type: Number,
    default: null
  },
  originalPercentage: {
    type: Number,
    default: null
  },
  teacherFeedback: {
    type: String,
    default: ''
  },
  recorrectionCompletedAt: {
    type: Date,
    default: null
  },
  recorrectionCompletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Index for efficient queries and SaaS multi-tenancy
quizResultSchema.index({ organizationId: 1, student: 1, quiz: 1 });
quizResultSchema.index({ organizationId: 1, student: 1, createdAt: -1 });
quizResultSchema.index({ organizationId: 1, teacherId: 1, createdAt: -1 });
quizResultSchema.index({ organizationId: 1, quiz: 1 });
quizResultSchema.index({ student: 1, quiz: 1 }); // Keep for backwards compatibility
quizResultSchema.index({ student: 1, createdAt: -1 }); // Keep for backwards compatibility

// Static method to find results by organization
quizResultSchema.statics.findByOrganization = function(organizationId, filter = {}) {
  return this.find({ organizationId, ...filter });
};

// Static method to find results for teacher
quizResultSchema.statics.findByTeacher = function(teacherId, organizationId, filter = {}) {
  return this.find({ organizationId, teacherId, ...filter });
};

// Static method to find results for student
quizResultSchema.statics.findByStudent = function(studentId, organizationId, filter = {}) {
  return this.find({ organizationId, student: studentId, ...filter });
};

// Static method to get quiz analytics
quizResultSchema.statics.getQuizAnalytics = function(quizId, organizationId) {
  return this.aggregate([
    { $match: { quiz: quizId, organizationId } },
    {
      $group: {
        _id: null,
        totalAttempts: { $sum: 1 },
        averageScore: { $avg: '$score' },
        averagePercentage: { $avg: '$percentage' },
        averageTime: { $avg: '$timeTaken' },
        maxScore: { $max: '$score' },
        minScore: { $min: '$score' }
      }
    }
  ]);
};

module.exports = mongoose.model('QuizResult', quizResultSchema); 