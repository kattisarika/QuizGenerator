const mongoose = require('mongoose');

const whiteboardSessionSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  gradeLevel: {
    type: String,
    required: true,
    enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade']
  },
  subject: {
    type: String,
    required: true,
    enum: ['English', 'Science', 'Math', 'History', 'Geography', 'Literature', 'Art', 'Music', 'Physical Education', 'Computer Science']
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
  sessionMode: {
    type: String,
    enum: ['live', 'recorded'],
    default: 'live'
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'ended', 'archived'],
    default: 'active'
  },
  collaborationSettings: {
    studentWritingEnabled: {
      type: Boolean,
      default: false
    },
    studentDrawingEnabled: {
      type: Boolean,
      default: false
    },
    maxActiveStudents: {
      type: Number,
      default: 5
    }
  },
  boardContent: {
    pages: [{
      pageNumber: {
        type: Number,
        required: true
      },
      elements: [{
        type: {
          type: String,
          enum: ['path', 'rect', 'circle', 'line', 'arrow', 'text', 'image', 'math'],
          required: true
        },
        data: mongoose.Schema.Types.Mixed, // Fabric.js object data
        timestamp: {
          type: Date,
          default: Date.now
        },
        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        }
      }],
      background: {
        type: String,
        default: '#ffffff'
      },
      zoom: {
        type: Number,
        default: 1
      },
      pan: {
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 }
      }
    }],
    currentPage: {
      type: Number,
      default: 1
    }
  },
  uploadedFiles: [{
    filename: String,
    originalName: String,
    mimeType: String,
    size: Number,
    url: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  recording: {
    isRecording: {
      type: Boolean,
      default: false
    },
    audioUrl: String,
    videoUrl: String,
    duration: Number,
    startedAt: Date,
    endedAt: Date
  },
  participants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    role: {
      type: String,
      enum: ['teacher', 'student', 'observer'],
      default: 'student'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    lastActive: Date,
    permissions: {
      canWrite: { type: Boolean, default: false },
      canDraw: { type: Boolean, default: false },
      canErase: { type: Boolean, default: false }
    }
  }],
  snapshots: [{
    name: String,
    description: String,
    imageUrl: String,
    createdAt: {
      type: Date,
      default: Date.now
    },
    pageNumber: Number
  }],
  tags: [String],
  isPublic: {
    type: Boolean,
    default: false
  },
  scheduledFor: Date,
  endedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update timestamps
whiteboardSessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Indexes for efficient queries
whiteboardSessionSchema.index({ organizationId: 1, gradeLevel: 1, subject: 1 });
whiteboardSessionSchema.index({ teacher: 1, status: 1 });
whiteboardSessionSchema.index({ 'participants.user': 1 });
whiteboardSessionSchema.index({ createdAt: -1 });

// Virtual for session duration
whiteboardSessionSchema.virtual('duration').get(function() {
  if (this.endedAt && this.createdAt) {
    return this.endedAt - this.createdAt;
  }
  return null;
});

// Instance methods
whiteboardSessionSchema.methods.addParticipant = function(userId, role = 'student', permissions = {}) {
  const existingParticipant = this.participants.find(p => p.user.toString() === userId.toString());
  
  if (existingParticipant) {
    existingParticipant.lastActive = new Date();
    existingParticipant.permissions = { ...existingParticipant.permissions, ...permissions };
  } else {
    this.participants.push({
      user: userId,
      role,
      permissions: {
        canWrite: role === 'teacher' || permissions.canWrite,
        canDraw: role === 'teacher' || permissions.canDraw,
        canErase: role === 'teacher' || permissions.canErase
      }
    });
  }
  
  return this.save();
};

whiteboardSessionSchema.methods.removeParticipant = function(userId) {
  this.participants = this.participants.filter(p => p.user.toString() !== userId.toString());
  return this.save();
};

whiteboardSessionSchema.methods.addElement = function(pageNumber, elementData, userId) {
  const page = this.boardContent.pages.find(p => p.pageNumber === pageNumber);
  if (!page) {
    throw new Error('Page not found');
  }
  
  page.elements.push({
    ...elementData,
    createdBy: userId,
    timestamp: new Date()
  });
  
  return this.save();
};

whiteboardSessionSchema.methods.takeSnapshot = function(pageNumber, name, description) {
  const snapshot = {
    name: name || `Snapshot ${this.snapshots.length + 1}`,
    description: description || '',
    pageNumber,
    createdAt: new Date()
  };
  
  this.snapshots.push(snapshot);
  return this.save();
};

// Static methods
whiteboardSessionSchema.statics.findByGradeAndSubject = function(organizationId, gradeLevel, subject) {
  return this.find({
    organizationId,
    gradeLevel,
    subject,
    status: { $in: ['ended', 'archived'] },
    isPublic: true
  }).populate('teacher', 'displayName').sort({ createdAt: -1 });
};

whiteboardSessionSchema.statics.findActiveByTeacher = function(teacherId) {
  return this.find({
    teacher: teacherId,
    status: { $in: ['active', 'paused'] }
  }).populate('participants.user', 'displayName role').sort({ createdAt: -1 });
};

module.exports = mongoose.model('WhiteboardSession', whiteboardSessionSchema); 