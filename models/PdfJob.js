const mongoose = require('mongoose');

const pdfJobSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['pending', 'processing', 'done', 'error'],
    default: 'pending'
  },
  // S3 keys for the uploaded PDFs
  questionPaperKey: { type: String, required: true },
  answerPaperKey:   { type: String, default: null },
  // Full URLs stored on the quiz record (for student access)
  questionPaperUrl: { type: String, required: true },
  answerPaperUrl:   { type: String, default: null },
  // PDF content stored as base64 — worker uses this directly (no filesystem/S3 download needed)
  questionPaperData: { type: String, default: null },
  answerPaperData:   { type: String, default: null },
  // Quiz metadata needed to create the Quiz document
  quizMeta: {
    title:           { type: String, required: true },
    subject:         { type: String, required: true },
    gradeLevel:      { type: String, required: true },
    quizType:        { type: String, default: 'regular' },
    createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName:   { type: String, required: true },
    organizationId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true }
  },
  // Set when done
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  // Set when error
  errorMessage: { type: String, default: null },
  // Progress message shown to user
  progressMessage: { type: String, default: 'Uploading PDF...' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

pdfJobSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Auto-delete completed/failed jobs after 1 hour
pdfJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('PdfJob', pdfJobSchema);
