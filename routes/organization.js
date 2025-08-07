const express = require('express');
const router = express.Router();
const Organization = require('../models/Organization');
const User = require('../models/User');
const { 
  detectOrganization, 
  requireOrganization, 
  requireOrganizationMember, 
  requireOrganizationPermission,
  requireActiveSubscription,
  checkOrganizationLimits,
  scopeToOrganization,
  logOrganizationActivity
} = require('../middleware/tenancy');

// Apply organization detection to all routes
router.use(detectOrganization);
router.use(scopeToOrganization);

/**
 * GET /api/check-subdomain/:subdomain
 * Check if subdomain is available
 */
router.get('/api/check-subdomain/:subdomain', async (req, res) => {
  try {
    const { subdomain } = req.params;
    
    // Validate subdomain format
    if (!/^[a-z0-9-]+$/.test(subdomain) || subdomain.length < 3 || subdomain.length > 50) {
      return res.json({ 
        available: false, 
        error: 'Subdomain must be 3-50 characters long and contain only lowercase letters, numbers, and hyphens.' 
      });
    }
    
    // Check reserved subdomains
    const reserved = ['www', 'app', 'api', 'admin', 'mail', 'ftp', 'blog', 'help', 'support', 'docs'];
    if (reserved.includes(subdomain)) {
      return res.json({ 
        available: false, 
        error: 'This subdomain is reserved.' 
      });
    }
    
    // Check if subdomain exists
    const existing = await Organization.findOne({ subdomain });
    
    res.json({ 
      available: !existing,
      subdomain: subdomain
    });
  } catch (error) {
    console.error('Error checking subdomain:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/create-organization
 * Create a new organization for a teacher
 */
router.post('/api/create-organization', async (req, res) => {
  try {
    const { organizationName, subdomain, teacherName, email, bio, planType = 'free' } = req.body;
    
    // Validate required fields
    if (!organizationName || !subdomain || !teacherName || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate subdomain
    if (!/^[a-z0-9-]+$/.test(subdomain) || subdomain.length < 3 || subdomain.length > 50) {
      return res.status(400).json({ error: 'Invalid subdomain format' });
    }
    
    // Check if subdomain is available
    const existingOrg = await Organization.findOne({ subdomain });
    if (existingOrg) {
      return res.status(400).json({ error: 'Subdomain already taken' });
    }
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Create temporary user record first (will be completed during OAuth)
    const tempUser = new User({
      displayName: teacherName,
      email,
      role: 'teacher',
      organizationRole: 'owner',
      isApproved: true,
      teacherProfile: {
        bio: bio || ''
      },
      // Temporary googleId - will be updated during OAuth
      googleId: `temp_${Date.now()}_${Math.random()}`
    });
    
    await tempUser.save();
    
    // Get plan limits and structure them properly
    const planLimits = Organization.getPlanLimits(planType);
    
    // Create organization with the user as owner
    const organization = new Organization({
      name: organizationName,
      subdomain: subdomain.toLowerCase(),
      ownerId: tempUser._id,
      planType,
      contact: {
        email
      },
      settings: {
        maxStudents: planLimits.maxStudents,
        maxQuizzes: planLimits.maxQuizzes,
        maxStorage: planLimits.maxStorage,
        features: planLimits.features
      }
    });
    
    await organization.save();
    
    // Update user with organization reference
    tempUser.organizationId = organization._id;
    await tempUser.save();
    
    // Log organization creation
    console.log(`New organization created: ${organizationName} (${subdomain}) by ${email}`);
    
    res.json({
      success: true,
      organizationId: organization._id,
      subdomain,
      message: 'Organization created successfully'
    });
  } catch (error) {
    console.error('Error creating organization:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

/**
 * GET /organization/dashboard
 * Organization dashboard for owners/admins
 */
// Custom middleware to set organization context from user for dashboard access
const setOrganizationFromUser = async (req, res, next) => {
  try {
    if (req.user && req.user.organizationId) {
      const organization = await Organization.findById(req.user.organizationId);
      if (organization) {
        req.organization = organization;
        req.organizationId = organization._id;
        res.locals.organization = organization;
        res.locals.organizationId = req.organizationId;
      }
    }
    next();
  } catch (error) {
    console.error('Error setting organization from user:', error);
    next();
  }
};

router.get('/organization/dashboard', 
  setOrganizationFromUser,
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('view_analytics'),
  async (req, res) => {
    try {
      const org = req.organization;
      
      // Get organization stats
      const students = await User.findByOrganization(org._id, { role: 'student' });
      const teachers = await User.findByOrganization(org._id, { role: 'teacher' });
      const Quiz = require('../models/Quiz');
      const Content = require('../models/Content');
      const QuizResult = require('../models/QuizResult');
      
      const quizzes = await Quiz.findByOrganization(org._id);
      const content = await Content.findByOrganization(org._id);
      const recentResults = await QuizResult.findByOrganization(org._id, {})
        .populate('student', 'displayName email')
        .populate('quiz', 'title')
        .sort({ createdAt: -1 })
        .limit(10);
      
      // Update organization stats
      org.stats.totalStudents = students.length;
      org.stats.totalQuizzes = quizzes.length;
      org.stats.totalContent = content.length;
      await org.save();
      
      res.render('organization-dashboard', {
        title: 'Organization Dashboard',
        organization: org,
        stats: {
          students: students.length,
          teachers: teachers.length,
          quizzes: quizzes.length,
          content: content.length
        },
        recentResults,
        limits: Organization.getPlanLimits(org.planType),
        user: req.user
      });
    } catch (error) {
      console.error('Error loading organization dashboard:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to load dashboard',
        error: { status: 500 }
      });
    }
  }
);

/**
 * GET /organization/settings
 * Organization settings page
 */
router.get('/organization/settings',
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('all'),
  async (req, res) => {
    try {
      res.render('organization-settings', {
        title: 'Organization Settings',
        organization: req.organization,
        user: req.user
      });
    } catch (error) {
      console.error('Error loading organization settings:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to load settings',
        error: { status: 500 }
      });
    }
  }
);

/**
 * POST /organization/settings
 * Update organization settings
 */
router.post('/organization/settings',
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('all'),
  logOrganizationActivity('update_settings'),
  async (req, res) => {
    try {
      const { name, email, phone, address, primaryColor, secondaryColor, customDomain } = req.body;
      const org = req.organization;
      
      // Update organization
      org.name = name || org.name;
      org.contact.email = email || org.contact.email;
      org.contact.phone = phone || org.contact.phone;
      
      if (address) {
        org.contact.address = {
          street: address.street || '',
          city: address.city || '',
          state: address.state || '',
          zipCode: address.zipCode || '',
          country: address.country || ''
        };
      }
      
      if (org.hasFeature('customBranding')) {
        org.branding.primaryColor = primaryColor || org.branding.primaryColor;
        org.branding.secondaryColor = secondaryColor || org.branding.secondaryColor;
        org.branding.customDomain = customDomain || org.branding.customDomain;
      }
      
      await org.save();
      
      res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
      console.error('Error updating organization settings:', error);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  }
);

/**
 * GET /organization/members
 * List organization members
 */
router.get('/organization/members',
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('manage_users'),
  async (req, res) => {
    try {
      const members = await User.findByOrganization(req.organizationId)
        .sort({ createdAt: -1 });
      
      res.render('organization-members', {
        title: 'Manage Members',
        organization: req.organization,
        members,
        user: req.user
      });
    } catch (error) {
      console.error('Error loading organization members:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to load members',
        error: { status: 500 }
      });
    }
  }
);

/**
 * POST /organization/invite-student
 * Invite a student to join the organization
 */
router.post('/organization/invite-student',
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('manage_students'),
  checkOrganizationLimits('students'),
  logOrganizationActivity('invite_student'),
  async (req, res) => {
    try {
      const { email, gradeLevel, subjects } = req.body;
      
      if (!email || !gradeLevel) {
        return res.status(400).json({ error: 'Email and grade level are required' });
      }
      
      // Check if user already exists in this organization
      const existingUser = await User.findOne({ 
        email, 
        organizationId: req.organizationId 
      });
      
      if (existingUser) {
        return res.status(400).json({ error: 'User already exists in this organization' });
      }
      
      // Create pending user invitation
      const invitation = new User({
        email,
        displayName: email.split('@')[0], // Temporary name
        role: 'student',
        organizationId: req.organizationId,
        organizationRole: 'student',
        gradeLevel,
        subjects: subjects || [],
        assignedTeacher: req.user._id,
        invitationStatus: 'pending',
        invitedBy: req.user._id,
        invitedAt: new Date(),
        // Temporary googleId - will be updated when user signs up
        googleId: `invite_${Date.now()}_${Math.random()}`
      });
      
      await invitation.save();
      
      // TODO: Send invitation email
      
      res.json({ 
        success: true, 
        message: 'Student invitation created successfully',
        invitationId: invitation._id
      });
    } catch (error) {
      console.error('Error inviting student:', error);
      res.status(500).json({ error: 'Failed to invite student' });
    }
  }
);

/**
 * GET /organization/billing
 * Organization billing and subscription management
 */
router.get('/organization/billing',
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('all'),
  async (req, res) => {
    try {
      const org = req.organization;
      const limits = Organization.getPlanLimits(org.planType);
      
      res.render('organization-billing', {
        title: 'Billing & Subscription',
        organization: org,
        limits,
        user: req.user
      });
    } catch (error) {
      console.error('Error loading billing page:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to load billing information',
        error: { status: 500 }
      });
    }
  }
);

// Student account creation route
router.post('/api/create-student-account', async (req, res) => {
  try {
    const { studentName, email, gradeLevel, organizationCode, subjects } = req.body;
    
    // Validate required fields
    if (!studentName || !email || !gradeLevel || !organizationCode) {
      return res.status(400).json({
        success: false,
        message: 'Please fill in all required fields'
      });
    }
    
    // Find organization by subdomain (organizationCode)
    const organization = await Organization.findOne({ subdomain: organizationCode });
    if (!organization) {
      return res.status(400).json({
        success: false,
        message: 'Invalid organization code. Please check with your teacher.'
      });
    }
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email already exists'
      });
    }
    
    // Create temporary student user (will be completed during Google OAuth)
    const tempUser = new User({
      googleId: `temp_student_${Date.now()}`,
      displayName: studentName,
      email: email,
      role: 'student',
      organizationId: organization._id,
      organizationRole: 'student',
      gradeLevel: gradeLevel,
      subjects: subjects || [],
      isApproved: true, // Students are auto-approved
      invitationStatus: 'pending'
    });
    
    await tempUser.save();
    
    console.log('Temporary student user created:', {
      email: tempUser.email,
      organization: organization.name,
      gradeLevel: tempUser.gradeLevel
    });
    
    res.json({
      success: true,
      message: 'Student account created successfully! Please sign in with Google.',
      organizationName: organization.name
    });
    
  } catch (error) {
    console.error('Error creating student account:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while creating your account. Please try again.'
    });
  }
});

module.exports = router;