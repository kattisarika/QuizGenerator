const mongoose = require('mongoose');

const studentAssignmentSchema = new mongoose.Schema({
  // Student Information
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  studentName: {
    type: String,
    required: true
  },
  studentEmail: {
    type: String,
    required: true
  },
  
  // Assignment Details
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  category: {
    type: String,
    enum: ['Assignment', 'Doubts'],
    required: true
  },
  grade: {
    type: String,
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  
  // File Information
  fileName: {
    type: String,
    required: true
  },
  originalFileName: {
    type: String,
    required: true
  },
  fileUrl: {
    type: String,
    required: true
  },
  fileType: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    required: true
  },
  
  // Organization and Teacher
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  assignedTeacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Status and Review
  status: {
    type: String,
    enum: ['submitted', 'under_review', 'reviewed', 'returned'],
    default: 'submitted'
  },
  submittedAt: {
    type: Date,
    default: Date.now
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Teacher Feedback
  teacherComments: {
    type: String,
    default: ''
  },
  grade_score: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  feedback: {
    type: String,
    default: ''
  },
  
  // Additional Metadata
  tags: [{
    type: String,
    trim: true
  }],
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  dueDate: {
    type: Date,
    default: null
  },
  
  // Tracking
  viewedByTeacher: {
    type: Boolean,
    default: false
  },
  viewedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
studentAssignmentSchema.index({ organizationId: 1, student: 1, createdAt: -1 });
studentAssignmentSchema.index({ organizationId: 1, assignedTeacher: 1, status: 1 });
studentAssignmentSchema.index({ organizationId: 1, category: 1, grade: 1 });
studentAssignmentSchema.index({ organizationId: 1, status: 1, submittedAt: -1 });

// Static method to find assignments by organization
studentAssignmentSchema.statics.findByOrganization = function(organizationId, filter = {}) {
  return this.find({ organizationId, ...filter });
};

// Static method to get assignments for a specific teacher
studentAssignmentSchema.statics.getTeacherAssignments = function(teacherId, organizationId) {
  return this.find({ 
    $or: [
      { assignedTeacher: teacherId },
      { assignedTeacher: null } // Unassigned assignments
    ],
    organizationId 
  }).populate('student', 'displayName email')
    .sort({ submittedAt: -1 });
};

// Static method to get student's assignments
studentAssignmentSchema.statics.getStudentAssignments = function(studentId, organizationId) {
  return this.find({ student: studentId, organizationId })
    .populate('assignedTeacher', 'displayName email')
    .populate('reviewedBy', 'displayName email')
    .sort({ submittedAt: -1 });
};

// Method to mark as viewed by teacher
studentAssignmentSchema.methods.markAsViewed = function(teacherId) {
  this.viewedByTeacher = true;
  this.viewedAt = new Date();
  if (!this.assignedTeacher) {
    this.assignedTeacher = teacherId;
  }
  return this.save();
};

// Method to add teacher review
studentAssignmentSchema.methods.addReview = function(teacherId, comments, score, feedback) {
  this.status = 'reviewed';
  this.reviewedAt = new Date();
  this.reviewedBy = teacherId;
  this.teacherComments = comments || '';
  this.grade_score = score || null;
  this.feedback = feedback || '';
  this.assignedTeacher = teacherId;
  return this.save();
};

module.exports = mongoose.model('StudentAssignment', studentAssignmentSchema);
