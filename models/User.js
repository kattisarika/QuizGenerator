const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: {
    type: String,
    required: true,
    unique: true
  },
  displayName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true
  },
  photos: [{
    value: String
  }],
  role: {
    type: String,
    enum: ['student', 'teacher', 'admin', 'super_admin'],
    default: 'student'
  },
  isApproved: {
    type: Boolean,
    default: false
  },
  gradeLevel: {
    type: String,
    enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'],
    default: null
  },
  subjects: [{
    type: String,
    enum: ['English', 'Science', 'Math']
  }],
  assignedTeacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // SaaS Multi-tenancy fields
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: function() {
      // Don't require organizationId for super_admin or temporary users during org creation
      return this.role !== 'super_admin' && !this.googleId?.startsWith('temp_');
    }
  },
  organizationRole: {
    type: String,
    enum: ['owner', 'admin', 'teacher', 'student'],
    default: function() {
      if (this.role === 'teacher') return 'teacher';
      if (this.role === 'student') return 'student';
      return 'student';
    }
  },
  // Teacher-specific fields for SaaS
  teacherProfile: {
    bio: String,
    specialization: [String],
    experience: Number, // years
    certification: [String],
    contactPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true }
    }
  },
  // Multi-organization memberships for students
  organizationMemberships: [{
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'teacher', 'student'],
      default: 'student'
    },
    gradeLevel: {
      type: String,
      enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade']
    },
    subjects: [{
      type: String,
      enum: ['English', 'Science', 'Math']
    }],
    joinedAt: {
      type: Date,
      default: Date.now
    },
    isActive: {
      type: Boolean,
      default: true
    }
  }],
  // Current active organization (for session context)
  currentOrganizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization'
  },
  // Student invitation tracking
  invitationStatus: {
    type: String,
    enum: ['pending', 'accepted', 'declined'],
    default: 'accepted' // For existing users
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  invitedAt: Date,
  // Subscription and billing (for organization owners)
  billing: {
    stripeCustomerId: String,
    paymentMethods: [{
      id: String,
      type: String,
      last4: String,
      brand: String,
      isDefault: Boolean
    }]
  },
  // Activity tracking
  lastActive: {
    type: Date,
    default: Date.now
  },
  preferences: {
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'light'
    },
    language: {
      type: String,
      enum: ['English', 'Spanish', 'French', 'Kannada'],
      default: 'English'
    },
    notifications: {
      quiz: { type: Boolean, default: true },
      grades: { type: Boolean, default: true },
      announcements: { type: Boolean, default: true }
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

// Pre-save middleware to update lastActive and updatedAt
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  if (this.isModified() && !this.isNew) {
    this.lastActive = new Date();
  }
  next();
});

// Indexes for efficient queries
userSchema.index({ organizationId: 1, role: 1 });
userSchema.index({ organizationId: 1, assignedTeacher: 1 });
userSchema.index({ email: 1 });
userSchema.index({ googleId: 1 });
userSchema.index({ organizationId: 1, invitationStatus: 1 });

// Virtual for organization-scoped user ID
userSchema.virtual('scopedId').get(function() {
  return `${this.organizationId}_${this._id}`;
});

// Static method to find users by organization
userSchema.statics.findByOrganization = function(organizationId, filter = {}) {
  return this.find({ organizationId, ...filter });
};

// Static method to find students by teacher
userSchema.statics.findStudentsByTeacher = function(teacherId, organizationId) {
  return this.find({
    organizationId,
    assignedTeacher: teacherId,
    role: 'student'
  });
};

// Instance method to check if user belongs to organization
userSchema.methods.belongsToOrganization = function(organizationId) {
  return this.organizationId && this.organizationId.toString() === organizationId.toString();
};

// Instance method to check if user can access resource
userSchema.methods.canAccess = function(resource) {
  const permissions = {
    owner: ['all'],
    admin: ['manage_users', 'manage_content', 'view_analytics', 'manage_quizzes'],
    teacher: ['manage_students', 'create_content', 'create_quizzes', 'view_results', 'view_analytics'],
    student: ['take_quiz', 'view_content', 'view_own_results']
  };
  
  // Determine the role to use for permission checking
  let roleForPermissions = this.organizationRole;
  
  // Fallback logic if organizationRole is not set
  if (!roleForPermissions) {
    // For teachers with organizationId, assume they have at least teacher permissions
    // In SaaS model, teachers who created organizations should be owners
    if (this.role === 'teacher' && this.organizationId) {
      // TODO: This could be enhanced to check if they're the actual org owner in the Organization model
      // For now, give teacher permissions as minimum
      roleForPermissions = 'teacher';
    } else {
      // Use their main role as fallback
      roleForPermissions = this.role;
    }
  }
  
  const userPermissions = permissions[roleForPermissions] || permissions.student;
  return userPermissions.includes('all') || userPermissions.includes(resource);
};

// Instance method to get display role
userSchema.methods.getDisplayRole = function() {
  if (this.role === 'super_admin') return 'Super Administrator';
  if (this.organizationRole === 'owner') return 'Organization Owner';
  if (this.organizationRole === 'admin') return 'Administrator';
  if (this.organizationRole === 'teacher') return 'Teacher';
  return 'Student';
};

module.exports = mongoose.model('User', userSchema); 