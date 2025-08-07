const mongoose = require('mongoose');

const contentSchema = new mongoose.Schema({
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
    enum: ['Lecture Notes', 'Study Material', 'Assignment', 'Reference', 'Other'],
    default: 'Other'
  },
  gradeLevel: {
    type: String,
    enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', 
           '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'],
    required: true
  },
  fileUrl: {
    type: String,
    required: true
  },
  fileName: {
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
    default: false
  },
  downloads: {
    type: Number,
    default: 0
  },
  views: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries and SaaS multi-tenancy
contentSchema.index({ organizationId: 1, createdBy: 1, createdAt: -1 });
contentSchema.index({ organizationId: 1, category: 1 });
contentSchema.index({ organizationId: 1, isApproved: 1 });
contentSchema.index({ organizationId: 1, gradeLevel: 1 });
contentSchema.index({ createdBy: 1, createdAt: -1 }); // Keep for backwards compatibility

// Static method to find content by organization
contentSchema.statics.findByOrganization = function(organizationId, filter = {}) {
  return this.find({ organizationId, ...filter });
};

// Static method to find approved content for students
contentSchema.statics.findApprovedForOrganization = function(organizationId, gradeLevel = null) {
  const filter = { organizationId, isApproved: true };
  if (gradeLevel) filter.gradeLevel = gradeLevel;
  return this.find(filter).sort({ createdAt: -1 });
};

// Instance method to increment views
contentSchema.methods.incrementViews = function() {
  this.views = (this.views || 0) + 1;
  return this.save();
};

// Instance method to increment downloads
contentSchema.methods.incrementDownloads = function() {
  this.downloads = (this.downloads || 0) + 1;
  return this.save();
};

module.exports = mongoose.model('Content', contentSchema); 