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
  timeTaken: {
    type: Number, // in seconds
    default: 0
  },
  correctAnswers: {
    type: Number,
    default: 0
  },
  totalAnswers: {
    type: Number,
    default: 0
  },
  accuracy: {
    type: Number, // percentage
    default: 0
  },
  score: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['waiting', 'in-progress', 'completed', 'absent'],
    default: 'waiting'
  },
  answers: [{
    questionIndex: Number,
    selectedAnswer: String,
    isCorrect: Boolean,
    answeredAt: Date
  }]
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
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  sessionCode: {
    type: String,
    unique: true,
    required: true
  },
  scheduledStartTime: {
    type: Date,
    required: true
  },
  actualStartTime: {
    type: Date,
    default: null
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number, // in minutes
    required: true,
    default: 30
  },
  status: {
    type: String,
    enum: ['scheduled', 'waiting', 'in-progress', 'completed', 'cancelled'],
    default: 'scheduled'
  },
  participants: [participantSchema],
  maxParticipants: {
    type: Number,
    default: 100
  },
  settings: {
    allowLateJoin: {
      type: Boolean,
      default: false
    },
    showLiveLeaderboard: {
      type: Boolean,
      default: true
    },
    randomizeQuestions: {
      type: Boolean,
      default: false
    },
    showResultsImmediately: {
      type: Boolean,
      default: true
    }
  },
  leaderboard: [{
    rank: Number,
    studentId: mongoose.Schema.Types.ObjectId,
    studentName: String,
    score: Number,
    correctAnswers: Number,
    timeTaken: Number,
    accuracy: Number
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Generate unique session code
quizSessionSchema.statics.generateSessionCode = function() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// Add participant to session
quizSessionSchema.methods.addParticipant = function(studentId, studentName) {
  const existingParticipant = this.participants.find(
    p => p.student.toString() === studentId.toString()
  );
  
  if (existingParticipant) {
    return existingParticipant;
  }
  
  if (this.participants.length >= this.maxParticipants) {
    throw new Error('Session is full');
  }
  
  const newParticipant = {
    student: studentId,
    studentName: studentName,
    joinedAt: new Date()
  };
  
  this.participants.push(newParticipant);
  return newParticipant;
};

// Update participant progress
quizSessionSchema.methods.updateParticipantProgress = function(studentId, progressData) {
  const participant = this.participants.find(
    p => p.student.toString() === studentId.toString()
  );
  
  if (!participant) {
    throw new Error('Participant not found');
  }
  
  Object.assign(participant, progressData);
  return participant;
};

// Calculate and update leaderboard
quizSessionSchema.methods.updateLeaderboard = function() {
  const completedParticipants = this.participants
    .filter(p => p.status === 'completed')
    .map(p => ({
      studentId: p.student,
      studentName: p.studentName,
      score: p.score,
      correctAnswers: p.correctAnswers,
      timeTaken: p.timeTaken,
      accuracy: p.accuracy
    }))
    .sort((a, b) => {
      // Sort by score (descending), then by time taken (ascending)
      if (b.score !== a.score) return b.score - a.score;
      return a.timeTaken - b.timeTaken;
    });
  
  this.leaderboard = completedParticipants.map((p, index) => ({
    rank: index + 1,
    ...p
  }));
  
  return this.leaderboard;
};

// Check if session is ready to start
quizSessionSchema.methods.canStart = function() {
  const now = new Date();
  const scheduledTime = new Date(this.scheduledStartTime);
  
  // Allow starting 5 minutes before scheduled time
  const fiveMinutesBefore = new Date(scheduledTime.getTime() - 5 * 60 * 1000);
  
  return now >= fiveMinutesBefore && this.status === 'scheduled';
};

// Start the session
quizSessionSchema.methods.start = function() {
  if (this.status !== 'scheduled' && this.status !== 'waiting') {
    throw new Error('Session cannot be started');
  }
  
  this.status = 'in-progress';
  this.actualStartTime = new Date();
  
  // Update all waiting participants to in-progress
  this.participants.forEach(p => {
    if (p.status === 'waiting') {
      p.status = 'in-progress';
      p.startedAt = new Date();
    }
  });
  
  return this;
};

// End the session
quizSessionSchema.methods.end = function() {
  this.status = 'completed';
  this.endTime = new Date();
  
  // Mark any in-progress participants as completed
  this.participants.forEach(p => {
    if (p.status === 'in-progress') {
      p.status = 'completed';
      p.completedAt = new Date();
      if (p.startedAt) {
        p.timeTaken = Math.floor((p.completedAt - p.startedAt) / 1000);
      }
    }
  });
  
  // Update final leaderboard
  this.updateLeaderboard();
  
  return this;
};

// Pre-save middleware to update timestamp
quizSessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('QuizSession', quizSessionSchema);