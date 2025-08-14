// Authentication middleware
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
};

// Role-based access control middleware
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.redirect('/login');
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to perform this action' 
      });
    }
    
    next();
  };
};

// Check if teacher is approved
const requireApprovedTeacher = (req, res, next) => {
  if (req.user.role === 'teacher' && !req.user.isApproved) {
    return res.status(403).json({ 
      success: false, 
      message: 'Your teacher account is pending approval' 
    });
  }
  next();
};

module.exports = {
  isAuthenticated,
  requireRole,
  requireApprovedTeacher
};