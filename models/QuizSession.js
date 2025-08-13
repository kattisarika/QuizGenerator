const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  studentName: {
    type: String,
    required: true
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  currentQuestion: {
    type: Number,
    default: 0
  },
  answersSubmitted: {
    type: Number,
    default: 0
  },
  timeTaken: {
    type: Number, // in seconds
    default: 0
  },
  score: {
    type: Number,
    default: 0
  },
  percentage: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['joined', 'in-progress', 'completed', 'disconnected'],
    default: 'joined'
  },
  questionProgress: [{
    questionIndex: Number,
    answeredAt: Date,
    timeTakenForQuestion: Number, // seconds taken for this specific question
    isCorrect: Boolean,
    selectedAnswer: String
  }],
  lastActivity: {
    type: Date,
    default: Date.now
  }
});

const quizSessionSchema = new mongoose.Schema({
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
    required: true
  },
  quizTitle: {
    type: String,
    required: true
  },
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  teacherName: {
    type: String,
    required: true
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  sessionCode: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['waiting', 'active', 'completed', 'cancelled'],
    default: 'waiting'
  },
  participants: [participantSchema],
  maxParticipants: {
    type: Number,
    default: 50
  },
  startTime: {
    type: Date,
    default: null
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number, // in minutes
    default: 30
  },
  settings: {
    showLeaderboard: {
      type: Boolean,
      default: true
    },
    showParticipantCount: {
      type: Boolean,
      default: true
    },
    allowLateJoin: {
      type: Boolean,
      default: true
    },
    instantResults: {
      type: Boolean,
      default: true
    }
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

// Indexes for efficient queries
quizSessionSchema.index({ organizationId: 1, teacher: 1, createdAt: -1 });
quizSessionSchema.index({ sessionCode: 1 });
quizSessionSchema.index({ organizationId: 1, status: 1 });
quizSessionSchema.index({ 'participants.student': 1 });

// Pre-save middleware
quizSessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Generate unique session code
quizSessionSchema.statics.generateSessionCode = function() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding I, O, 0, 1 for clarity
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// Static method to find active sessions
quizSessionSchema.statics.findActiveSessions = function(organizationId) {
  return this.find({ 
    organizationId, 
    status: { $in: ['waiting', 'active'] } 
  }).populate('quiz', 'title questions').populate('teacher', 'displayName');
};

// Static method to get session leaderboard
quizSessionSchema.statics.getLeaderboard = function(sessionId) {
  return this.findById(sessionId).then(session => {
    if (!session) return null;
    
    const leaderboard = session.participants
      .filter(p => p.status === 'completed')
      .map(p => ({
        studentId: p.student,
        studentName: p.studentName,
        score: p.score,
        percentage: p.percentage,
        timeTaken: p.timeTaken,
        completedAt: p.completedAt
      }))
      .sort((a, b) => {
        // Sort by score (descending), then by time (ascending)
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      });
    
    return leaderboard;
  });
};

// Instance method to add participant
quizSessionSchema.methods.addParticipant = function(studentId, studentName) {
  console.log('addParticipant called with:', { studentId, studentName });
  console.log('Current participants count:', this.participants.length);
  
  // Check if student already joined
  const existing = this.participants.find(p => p.student.toString() === studentId.toString());
  if (existing) {
    console.log('Student already exists, updating lastActivity');
    existing.lastActivity = new Date();
    return this.save();
  }
  
  // Check max participants
  if (this.participants.length >= this.maxParticipants) {
    throw new Error('Session is full');
  }
  
  console.log('Adding new participant to array');
  this.participants.push({
    student: studentId,
    studentName: studentName,
    joinedAt: new Date(),
    lastActivity: new Date()
  });
  
  console.log('Participants array after push:', this.participants.length);
  return this.save();
};

// Instance method to update participant progress
quizSessionSchema.methods.updateParticipantProgress = function(studentId, progress) {
  const participant = this.participants.find(p => p.student.toString() === studentId.toString());
  if (!participant) throw new Error('Participant not found');
  
  Object.assign(participant, progress, { lastActivity: new Date() });
  return this.save();
};

module.exports = mongoose.model('QuizSession', quizSessionSchema);