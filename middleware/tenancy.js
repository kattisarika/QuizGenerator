const Organization = require('../models/Organization');
const User = require('../models/User');

/**
 * Middleware to detect and set organization context based on subdomain or custom domain
 */
const detectOrganization = async (req, res, next) => {
  try {
    let organization = null;
    
    // Get the host header
    const host = req.get('host') || req.get('x-forwarded-host') || '';
    
    // Check if it's a custom domain
    if (host && !host.includes('skillons.com') && !host.includes('localhost') && !host.includes('herokuapp.com')) {
      // Look for organization by custom domain
      organization = await Organization.findOne({ 
        'branding.customDomain': host,
        isActive: true
      });
    } else {
      // Extract subdomain from skillons.com domains
      const subdomain = host.split('.')[0];
      
      // Skip if it's the main domain or common subdomains
      if (subdomain && !['www', 'app', 'api', 'admin'].includes(subdomain)) {
        organization = await Organization.findOne({ 
          subdomain: subdomain,
          isActive: true
        });
      }
    }
    
    // Set organization context
    req.organization = organization;
    req.organizationId = organization ? organization._id : null;
    
    // Add organization info to response locals for templates
    res.locals.organization = organization;
    res.locals.organizationId = req.organizationId;
    
    next();
  } catch (error) {
    console.error('Error detecting organization:', error);
    next();
  }
};

/**
 * Middleware to require organization context
 */
const requireOrganization = (req, res, next) => {
  if (!req.organization) {
    return res.status(404).render('error', {
      title: 'Organization Not Found',
      message: 'The organization you are trying to access does not exist or is not active.',
      error: { status: 404 }
    });
  }
  next();
};

/**
 * Middleware to check if user belongs to the current organization
 */
const requireOrganizationMember = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.redirect('/login');
    }

    if (!req.organization) {
      return res.status(404).render('error', {
        title: 'Organization Not Found',
        message: 'No organization context found.',
        error: { status: 404 }
      });
    }

    // Super admins can access any organization
    if (req.user.role === 'super_admin') {
      return next();
    }

    // Check if user belongs to this organization
    if (!req.user.organizationId || req.user.organizationId.toString() !== req.organizationId.toString()) {
      return res.status(403).render('error', {
        title: 'Access Denied',
        message: 'You do not have access to this organization.',
        error: { status: 403 }
      });
    }

    next();
  } catch (error) {
    console.error('Error checking organization membership:', error);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'An error occurred while verifying your access.',
      error: { status: 500 }
    });
  }
};

/**
 * Middleware to check organization permission
 */
const requireOrganizationPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.redirect('/login');
    }

    // Super admins have all permissions
    if (req.user.role === 'super_admin') {
      return next();
    }

    // Check if user has the required permission
    if (!req.user.canAccess(permission)) {
      return res.status(403).render('error', {
        title: 'Access Denied',
        message: 'You do not have permission to perform this action.',
        error: { status: 403 }
      });
    }

    next();
  };
};

/**
 * Middleware to check if organization subscription is active
 */
const requireActiveSubscription = (req, res, next) => {
  if (!req.organization) {
    return res.status(404).render('error', {
      title: 'Organization Not Found',
      message: 'No organization found.',
      error: { status: 404 }
    });
  }

  const { subscription } = req.organization;
  const now = new Date();

  // Check if subscription is active or in trial
  if (subscription.status === 'active' || 
      (subscription.status === 'trial' && subscription.endDate > now)) {
    return next();
  }

  // Subscription expired or cancelled
  return res.render('subscription-expired', {
    title: 'Subscription Required',
    organization: req.organization
  });
};

/**
 * Middleware to check organization limits (students, quizzes, storage)
 */
const checkOrganizationLimits = (type) => {
  return async (req, res, next) => {
    try {
      if (!req.organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      // Super admins bypass limits
      if (req.user && req.user.role === 'super_admin') {
        return next();
      }

      let canProceed = false;

      switch (type) {
        case 'students':
          canProceed = req.organization.canAddStudents(1);
          break;
        case 'quizzes':
          canProceed = req.organization.canAddQuizzes(1);
          break;
        case 'storage':
          // For storage, we'll check when we know the file size
          canProceed = true;
          break;
        default:
          canProceed = true;
      }

      if (!canProceed) {
        return res.status(403).json({
          error: `Organization limit reached for ${type}`,
          message: `Your current plan does not allow adding more ${type}. Please upgrade your subscription.`,
          planType: req.organization.planType,
          limits: Organization.getPlanLimits(req.organization.planType)
        });
      }

      next();
    } catch (error) {
      console.error('Error checking organization limits:', error);
      res.status(500).json({ error: 'Server error while checking limits' });
    }
  };
};

/**
 * Middleware to scope database queries to organization
 */
const scopeToOrganization = (req, res, next) => {
  // Add organization filter to query helpers
  req.orgFilter = (additionalFilter = {}) => {
    if (!req.organizationId) {
      throw new Error('No organization context available');
    }
    return { organizationId: req.organizationId, ...additionalFilter };
  };

  // Helper to ensure organizationId is added to create operations
  req.addOrgContext = (data = {}) => {
    if (!req.organizationId) {
      throw new Error('No organization context available');
    }
    return { ...data, organizationId: req.organizationId };
  };

  next();
};

/**
 * Middleware to log organization activity
 */
const logOrganizationActivity = (action) => {
  return (req, res, next) => {
    // Log the activity (you can extend this to save to database)
    console.log(`[${new Date().toISOString()}] Organization: ${req.organization?.subdomain || 'unknown'} | User: ${req.user?.email || 'anonymous'} | Action: ${action} | IP: ${req.ip}`);
    next();
  };
};

module.exports = {
  detectOrganization,
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission,
  requireActiveSubscription,
  checkOrganizationLimits,
  scopeToOrganization,
  logOrganizationActivity
};