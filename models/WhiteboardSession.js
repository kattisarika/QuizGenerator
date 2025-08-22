const mongoose = require('mongoose');

// Whiteboard Session Schema
const whiteboardSessionSchema = new mongoose.Schema({
  // Session Identification
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  joinCode: {
    type: String,
    required: true,
    unique: true,
    length: 6,
    uppercase: true
  },
  
  // Session Details
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  subject: {
    type: String,
    enum: ['Math', 'Science', 'English', 'History', 'Geography', 'Art', 'Other'],
    default: 'Other'
  },
  gradeLevel: {
    type: String,
    enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', 
           '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', 
           '11th grade', '12th grade'],
    required: true
  },
  
  // Teacher Information
  teacherId: {
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
  
  // Session Status
  status: {
    type: String,
    enum: ['waiting', 'active', 'paused', 'ended'],
    default: 'waiting'
  },
  isPasswordProtected: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    select: false // Don't include in queries by default
  },
  
  // Session Settings
  settings: {
    maxParticipants: {
      type: Number,
      default: 50,
      min: 1,
      max: 100
    },
    allowStudentDrawing: {
      type: Boolean,
      default: false
    },
    allowStudentChat: {
      type: Boolean,
      default: true
    },
    allowStudentVoice: {
      type: Boolean,
      default: false
    },
    allowStudentVideo: {
      type: Boolean,
      default: false
    },
    autoAdmitStudents: {
      type: Boolean,
      default: false
    },
    recordSession: {
      type: Boolean,
      default: false
    },
    enableAudio: {
      type: Boolean,
      default: true
    },
    enableVideo: {
      type: Boolean,
      default: true
    },
    audioQuality: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    },
    videoQuality: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    }
  },
  
  // Participants
  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    name: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['teacher', 'student'],
      required: true
    },
    status: {
      type: String,
      enum: ['waiting', 'admitted', 'denied', 'removed'],
      default: 'waiting'
    },
    permissions: {
      canDraw: {
        type: Boolean,
        default: false
      },
      canChat: {
        type: Boolean,
        default: true
      },
      canSpeak: {
        type: Boolean,
        default: false
      },
      canVideo: {
        type: Boolean,
        default: false
      }
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    lastActive: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Whiteboard Data
  whiteboardData: {
    canvas: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    drawings: [{
      id: String,
      type: {
        type: String,
        enum: ['path', 'text', 'image', 'shape']
      },
      data: mongoose.Schema.Types.Mixed,
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      timestamp: {
        type: Date,
        default: Date.now
      }
    }],
    uploadedFiles: [{
      filename: String,
      originalName: String,
      mimetype: String,
      size: Number,
      uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      uploadedAt: {
        type: Date,
        default: Date.now
      }
    }]
  },
  
  // Chat Messages
  chatMessages: [{
    id: {
      type: String,
      required: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    userName: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true,
      maxlength: 1000
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    isSystemMessage: {
      type: Boolean,
      default: false
    }
  }],
  
  // Session Timing
  scheduledStartTime: {
    type: Date
  },
  actualStartTime: {
    type: Date
  },
  endTime: {
    type: Date
  },
  duration: {
    type: Number, // in minutes
    default: 0
  },
  
  // Recording Information
  recording: {
    isRecorded: {
      type: Boolean,
      default: false
    },
    recordingUrl: String,
    recordingSize: Number,
    recordingDuration: Number
  },
  
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for performance
whiteboardSessionSchema.index({ teacherId: 1, status: 1 });
whiteboardSessionSchema.index({ organizationId: 1, status: 1 });
whiteboardSessionSchema.index({ joinCode: 1 });
whiteboardSessionSchema.index({ createdAt: -1 });

// Pre-save middleware
whiteboardSessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Methods
whiteboardSessionSchema.methods.generateJoinLink = function() {
  return `/whiteboard/join/${this.sessionId}`;
};

whiteboardSessionSchema.methods.addParticipant = function(userData) {
  const participant = {
    userId: userData.userId,
    name: userData.name,
    email: userData.email,
    role: userData.role || 'student',
    status: this.settings.autoAdmitStudents ? 'admitted' : 'waiting',
    permissions: {
      canDraw: userData.role === 'teacher' ? true : this.settings.allowStudentDrawing,
      canChat: userData.role === 'teacher' ? true : this.settings.allowStudentChat,
      canSpeak: userData.role === 'teacher' ? true : this.settings.allowStudentVoice,
      canVideo: userData.role === 'teacher' ? true : this.settings.allowStudentVideo
    }
  };
  
  this.participants.push(participant);
  return participant;
};

whiteboardSessionSchema.methods.removeParticipant = function(userId) {
  this.participants = this.participants.filter(p => !p.userId.equals(userId));
};

whiteboardSessionSchema.methods.updateParticipantStatus = function(userId, status) {
  const participant = this.participants.find(p => p.userId.equals(userId));
  if (participant) {
    participant.status = status;
    participant.lastActive = new Date();
  }
  return participant;
};

whiteboardSessionSchema.methods.addChatMessage = function(messageData) {
  const message = {
    id: new mongoose.Types.ObjectId().toString(),
    userId: messageData.userId,
    userName: messageData.userName,
    message: messageData.message,
    isSystemMessage: messageData.isSystemMessage || false
  };
  
  this.chatMessages.push(message);
  return message;
};

// Static methods
whiteboardSessionSchema.statics.generateSessionId = function() {
  return new mongoose.Types.ObjectId().toString();
};

whiteboardSessionSchema.statics.generateJoinCode = function() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

module.exports = mongoose.model('WhiteboardSession', whiteboardSessionSchema);
