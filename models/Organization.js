const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  subdomain: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: /^[a-z0-9-]+$/,
    maxlength: 50
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  planType: {
    type: String,
    enum: ['free', 'basic', 'premium', 'enterprise'],
    default: 'free'
  },
  settings: {
    maxStudents: {
      type: Number,
      default: 50 // Free plan limit
    },
    maxQuizzes: {
      type: Number,
      default: 10 // Free plan limit
    },
    maxStorage: {
      type: Number,
      default: 100 // MB
    },
    features: {
      multiLanguage: {
        type: Boolean,
        default: false
      },
      advancedAnalytics: {
        type: Boolean,
        default: false
      },
      customBranding: {
        type: Boolean,
        default: false
      },
      apiAccess: {
        type: Boolean,
        default: false
      }
    }
  },
  subscription: {
    status: {
      type: String,
      enum: ['active', 'trial', 'expired', 'cancelled'],
      default: 'trial'
    },
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: {
      type: Date,
      default: function() {
        // 30-day trial by default
        return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
    },
    stripeCustomerId: String,
    stripeSubscriptionId: String
  },
  contact: {
    email: {
      type: String,
      required: true
    },
    phone: String,
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String
    }
  },
  branding: {
    logo: String,
    primaryColor: {
      type: String,
      default: '#007bff'
    },
    secondaryColor: {
      type: String,
      default: '#6c757d'
    },
    customDomain: String
  },
  stats: {
    totalStudents: {
      type: Number,
      default: 0
    },
    totalQuizzes: {
      type: Number,
      default: 0
    },
    totalContent: {
      type: Number,
      default: 0
    },
    storageUsed: {
      type: Number,
      default: 0 // in MB
    }
  },
  isActive: {
    type: Boolean,
    default: true
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

// Update the updatedAt field before saving
organizationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Index for efficient queries
organizationSchema.index({ subdomain: 1 });
organizationSchema.index({ ownerId: 1 });
organizationSchema.index({ 'subscription.status': 1 });

// Virtual for full domain
organizationSchema.virtual('fullDomain').get(function() {
  if (this.branding.customDomain) {
    return this.branding.customDomain;
  }
  return `${this.subdomain}.skillons.com`;
});

// Static method to get plan limits
organizationSchema.statics.getPlanLimits = function(planType) {
  const limits = {
    free: {
      maxStudents: 50,
      maxQuizzes: 10,
      maxStorage: 100, // MB
      features: {
        multiLanguage: false,
        advancedAnalytics: false,
        customBranding: false,
        apiAccess: false
      }
    },
    basic: {
      maxStudents: 200,
      maxQuizzes: 50,
      maxStorage: 1000, // MB
      features: {
        multiLanguage: true,
        advancedAnalytics: false,
        customBranding: false,
        apiAccess: false
      }
    },
    premium: {
      maxStudents: 1000,
      maxQuizzes: 200,
      maxStorage: 5000, // MB
      features: {
        multiLanguage: true,
        advancedAnalytics: true,
        customBranding: true,
        apiAccess: false
      }
    },
    enterprise: {
      maxStudents: -1, // Unlimited
      maxQuizzes: -1, // Unlimited
      maxStorage: -1, // Unlimited
      features: {
        multiLanguage: true,
        advancedAnalytics: true,
        customBranding: true,
        apiAccess: true
      }
    }
  };
  return limits[planType] || limits.free;
};

// Instance method to check if organization can add more students
organizationSchema.methods.canAddStudents = function(count = 1) {
  const limits = this.constructor.getPlanLimits(this.planType);
  if (limits.maxStudents === -1) return true; // Unlimited
  return (this.stats.totalStudents + count) <= limits.maxStudents;
};

// Instance method to check if organization can add more quizzes
organizationSchema.methods.canAddQuizzes = function(count = 1) {
  const limits = this.constructor.getPlanLimits(this.planType);
  if (limits.maxQuizzes === -1) return true; // Unlimited
  return (this.stats.totalQuizzes + count) <= limits.maxQuizzes;
};

// Instance method to check storage limit
organizationSchema.methods.canAddStorage = function(sizeInMB) {
  const limits = this.constructor.getPlanLimits(this.planType);
  if (limits.maxStorage === -1) return true; // Unlimited
  return (this.stats.storageUsed + sizeInMB) <= limits.maxStorage;
};

// Instance method to check if feature is available
organizationSchema.methods.hasFeature = function(featureName) {
  const limits = this.constructor.getPlanLimits(this.planType);
  return limits.features[featureName] || false;
};

module.exports = mongoose.model('Organization', organizationSchema);