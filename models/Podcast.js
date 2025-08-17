const mongoose = require('mongoose');

const podcastSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  audioUrl: {
    type: String,
    required: true
  },
  duration: {
    type: Number, // Duration in seconds
    default: 0
  },
  fileSize: {
    type: Number, // File size in bytes
    default: 0
  },
  audioFormat: {
    type: String,
    enum: ['mp3', 'wav', 'ogg', 'm4a'],
    default: 'mp3'
  },
  gradeLevel: {
    type: String,
    enum: ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'],
    required: true
  },
  subjects: [{
    type: String,
    enum: ['English', 'Science', 'Math', 'History', 'Geography', 'Literature', 'Art', 'Music', 'Physical Education', 'Computer Science']
  }],
  tags: [{
    type: String,
    trim: true
  }],
  transcription: {
    type: String,
    default: ''
  },
  isTranscriptionEnabled: {
    type: Boolean,
    default: false
  },
  audioSettings: {
    trimStart: { type: Number, default: 0 }, // Start trim in seconds
    trimEnd: { type: Number, default: 0 },   // End trim in seconds
    noiseReduction: { type: Boolean, default: false },
    introMusic: { type: String, default: null }, // URL to intro music
    outroMusic: { type: String, default: null }  // URL to outro music
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
  isPublished: {
    type: Boolean,
    default: true
  },
  playCount: {
    type: Number,
    default: 0
  },
  rating: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 }
  }
}, {
  timestamps: true
});

// Index for efficient querying
podcastSchema.index({ gradeLevel: 1, subjects: 1, organizationId: 1, isPublished: 1 });
podcastSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('Podcast', podcastSchema); 