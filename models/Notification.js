const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  // Recipient Information
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipientRole: {
    type: String,
    enum: ['student', 'teacher', 'admin', 'super_admin'],
    required: true
  },
  
  // Notification Content
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: [
      'assignment_submitted',
      'assignment_reviewed',
      'assignment_returned',
      'quiz_completed',
      'quiz_graded',
      'new_quiz_available',
      'system_announcement',
      'general'
    ],
    required: true
  },
  
  // Status and Interaction
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date,
    default: null
  },
  
  // Related Data
  relatedId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  relatedType: {
    type: String,
    enum: ['assignment', 'quiz', 'quiz_result', 'user', 'announcement'],
    default: null
  },
  
  // Action Information
  actionUrl: {
    type: String,
    default: null
  },
  actionText: {
    type: String,
    default: null
  },
  
  // Organization Context
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  
  // Sender Information (optional)
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  senderName: {
    type: String,
    default: null
  },
  
  // Priority and Display
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  icon: {
    type: String,
    default: 'fas fa-bell'
  },
  color: {
    type: String,
    default: '#667eea'
  },
  
  // Expiration
  expiresAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ organizationId: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Static method to create notification
notificationSchema.statics.createNotification = async function(data) {
  const notification = new this({
    recipient: data.recipient,
    recipientRole: data.recipientRole,
    title: data.title,
    message: data.message,
    type: data.type,
    relatedId: data.relatedId || null,
    relatedType: data.relatedType || null,
    actionUrl: data.actionUrl || null,
    actionText: data.actionText || null,
    organizationId: data.organizationId,
    sender: data.sender || null,
    senderName: data.senderName || null,
    priority: data.priority || 'medium',
    icon: data.icon || 'fas fa-bell',
    color: data.color || '#667eea',
    expiresAt: data.expiresAt || null
  });
  
  await notification.save();
  console.log(`🔔 Notification created for ${data.recipientRole} ${data.recipient}: ${data.title}`);
  return notification;
};

// Static method to get user notifications
notificationSchema.statics.getUserNotifications = function(userId, limit = 20, unreadOnly = false) {
  const query = { recipient: userId };
  if (unreadOnly) {
    query.isRead = false;
  }
  
  return this.find(query)
    .populate('sender', 'displayName email')
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to get unread count
notificationSchema.statics.getUnreadCount = function(userId) {
  return this.countDocuments({ recipient: userId, isRead: false });
};

// Static method to mark as read
notificationSchema.statics.markAsRead = function(notificationId, userId) {
  return this.findOneAndUpdate(
    { _id: notificationId, recipient: userId },
    { isRead: true, readAt: new Date() },
    { new: true }
  );
};

// Static method to mark all as read
notificationSchema.statics.markAllAsRead = function(userId) {
  return this.updateMany(
    { recipient: userId, isRead: false },
    { isRead: true, readAt: new Date() }
  );
};

// Instance method to mark as read
notificationSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

// Static method for assignment notifications
notificationSchema.statics.createAssignmentNotification = async function(type, assignment, recipient, sender = null) {
  let title, message, actionUrl, actionText, icon, color;
  
  switch (type) {
    case 'assignment_submitted':
      title = 'New Assignment Submitted';
      message = `${assignment.studentName} submitted "${assignment.title}" for review`;
      actionUrl = `/teacher/assignment/${assignment._id}/review`;
      actionText = 'Review Assignment';
      icon = 'fas fa-file-upload';
      color = '#3b82f6';
      break;
      
    case 'assignment_reviewed':
      title = 'Assignment Reviewed';
      message = `Your assignment "${assignment.title}" has been reviewed`;
      actionUrl = `/student/assignment/${assignment._id}/result`;
      actionText = 'View Results';
      icon = 'fas fa-check-circle';
      color = '#10b981';
      break;
      
    case 'assignment_returned':
      title = 'Assignment Returned';
      message = `Your assignment "${assignment.title}" has been returned for revision`;
      actionUrl = `/student/assignment/${assignment._id}/revise`;
      actionText = 'View Feedback';
      icon = 'fas fa-undo';
      color = '#f59e0b';
      break;
      
    default:
      title = 'Assignment Update';
      message = `Update on assignment "${assignment.title}"`;
      actionUrl = null;
      actionText = null;
      icon = 'fas fa-file-alt';
      color = '#667eea';
  }
  
  return this.createNotification({
    recipient: recipient,
    recipientRole: type === 'assignment_submitted' ? 'teacher' : 'student',
    title: title,
    message: message,
    type: type,
    relatedId: assignment._id,
    relatedType: 'assignment',
    actionUrl: actionUrl,
    actionText: actionText,
    organizationId: assignment.organizationId,
    sender: sender,
    senderName: sender ? (sender.displayName || sender.email) : null,
    icon: icon,
    color: color
  });
};

// Static method for quiz notifications
notificationSchema.statics.createQuizNotification = async function(type, quiz, recipient, sender = null, additionalData = {}) {
  let title, message, actionUrl, actionText, icon, color;
  
  switch (type) {
    case 'new_quiz_available':
      title = 'New Quiz Available';
      message = `New quiz "${quiz.title}" is now available`;
      actionUrl = `/quiz/${quiz._id}`;
      actionText = 'Take Quiz';
      icon = 'fas fa-play-circle';
      color = '#8b5cf6';
      break;
      
    case 'quiz_completed':
      title = 'Quiz Completed';
      message = `Student completed quiz "${quiz.title}"`;
      actionUrl = `/teacher/quiz/${quiz._id}/results`;
      actionText = 'View Results';
      icon = 'fas fa-check-circle';
      color = '#10b981';
      break;
      
    case 'quiz_graded':
      title = 'Quiz Graded';
      message = `Your quiz "${quiz.title}" has been graded. Score: ${additionalData.score || 'N/A'}%`;
      actionUrl = `/my-results`;
      actionText = 'View Results';
      icon = 'fas fa-star';
      color = '#f59e0b';
      break;
      
    default:
      title = 'Quiz Update';
      message = `Update on quiz "${quiz.title}"`;
      actionUrl = null;
      actionText = null;
      icon = 'fas fa-question-circle';
      color = '#667eea';
  }
  
  return this.createNotification({
    recipient: recipient,
    recipientRole: type === 'quiz_completed' ? 'teacher' : 'student',
    title: title,
    message: message,
    type: type,
    relatedId: quiz._id,
    relatedType: 'quiz',
    actionUrl: actionUrl,
    actionText: actionText,
    organizationId: quiz.organizationId || recipient.organizationId,
    sender: sender,
    senderName: sender ? (sender.displayName || sender.email) : null,
    icon: icon,
    color: color
  });
};

module.exports = mongoose.model('Notification', notificationSchema);
