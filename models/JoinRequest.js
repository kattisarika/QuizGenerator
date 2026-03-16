const mongoose = require('mongoose');

const joinRequestSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  message: {
    type: String,
    default: ''
  },
  resolvedAt: {
    type: Date,
    default: null
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, { timestamps: true });

joinRequestSchema.index({ student: 1, organization: 1 }, { unique: true });
joinRequestSchema.index({ organization: 1, status: 1 });

module.exports = mongoose.model('JoinRequest', joinRequestSchema);
