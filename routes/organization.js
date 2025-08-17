const express = require('express');
const router = express.Router();
const Organization = require('../models/Organization');
const User = require('../models/User');
const emailService = require('../services/emailService');
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
    
    console.log('Organization creation request:', {
      organizationName,
      subdomain,
      teacherName,
      email,
      bio,
      planType
    });
    
    // Validate required fields
    if (!organizationName || !subdomain || !teacherName || !email) {
      console.log('Missing required fields:', {
        organizationName: !!organizationName,
        subdomain: !!subdomain,
        teacherName: !!teacherName,
        email: !!email
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate planType
    const validPlanTypes = ['free', 'basic', 'premium', 'enterprise'];
    if (planType && !validPlanTypes.includes(planType)) {
      return res.status(400).json({ 
        error: 'Invalid plan type', 
        validPlanTypes: validPlanTypes 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
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
      console.log('User already exists:', { email, existingUserId: existingUser._id });
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
      googleId: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });
    
    try {
      await tempUser.save();
    } catch (userError) {
      console.error('Error saving temporary user:', userError);
      if (userError.code === 11000 && userError.keyPattern?.googleId) {
        // Duplicate googleId, try again with a different one
        tempUser.googleId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await tempUser.save();
      } else {
        throw userError;
      }
    }
    
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
    console.log('Organization details:', {
      id: organization._id,
      planType: organization.planType,
      ownerId: organization.ownerId,
      settings: organization.settings
    });
    
    res.json({
      success: true,
      organizationId: organization._id,
      subdomain,
      message: 'Organization created successfully'
    });
  } catch (error) {
    console.error('Error creating organization:', error);
    
    // Provide more specific error messages
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    }
    
    if (error.code === 11000) {
      // Duplicate key error
      if (error.keyPattern?.subdomain) {
        return res.status(400).json({ error: 'Subdomain already taken' });
      }
      if (error.keyPattern?.email) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      return res.status(400).json({ error: 'Duplicate entry found' });
    }
    
    res.status(500).json({ error: 'Failed to create organization. Please try again.' });
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
 * GET /organization/invite-student
 * Display student invitation form
 */
router.get('/organization/invite-student',
  setOrganizationFromUser,
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('manage_students'),
  async (req, res) => {
    try {
      res.render('organization-invite-student', {
        title: 'Invite Student',
        organization: req.organization,
        user: req.user,
        limits: Organization.getPlanLimits(req.organization.planType)
      });
    } catch (error) {
      console.error('Error loading invite student page:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to load invite student page',
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
  setOrganizationFromUser,
  requireOrganization,
  requireOrganizationMember,
  requireOrganizationPermission('manage_students'),
  checkOrganizationLimits('students'),
  logOrganizationActivity('invite_student'),
  async (req, res) => {
    try {
      console.log('Invite student request body:', req.body);
      console.log('Content-Type:', req.get('Content-Type'));
      
      const { email, gradeLevel, subjects } = req.body;
      
      console.log('Extracted values:', { email, gradeLevel, subjects });
      
      if (!email || !gradeLevel) {
        console.log('Validation failed - email:', email, 'gradeLevel:', gradeLevel);
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
        isApproved: true, // Auto-approve invited students
        // Temporary googleId - will be updated when user signs up
        googleId: `invite_${Date.now()}_${Math.random()}`
      });
      
      console.log('Creating invitation for:', invitation.email);
      try {
        await invitation.save();
        console.log('Invitation saved successfully:', invitation._id);
      } catch (saveError) {
        console.error('Error saving invitation:', saveError);
        return res.status(400).json({ error: saveError.message || 'Failed to create invitation' });
      }
      
      // Send invitation email
      const invitationData = {
        email: invitation.email,
        organizationName: req.organization.name,
        organizationCode: req.organization.subdomain,
        teacherName: req.user.displayName,
        gradeLevel: invitation.gradeLevel,
        subjects: invitation.subjects || []
      };

      console.log('Sending invitation email to:', invitation.email);
      const emailResult = await emailService.sendStudentInvitation(invitationData);
      
      if (emailResult.success) {
        console.log('Invitation email sent successfully');
        res.json({ 
          success: true, 
          message: 'Student invitation sent successfully! They will receive an email with instructions to join.',
          invitationId: invitation._id,
          emailSent: true
        });
      } else {
        console.log('Email service not available or failed:', emailResult.message);
        res.json({ 
          success: true, 
          message: 'Student invitation created successfully. Please share the organization code manually as email service is not configured.',
          invitationId: invitation._id,
          emailSent: false,
          organizationCode: req.organization.subdomain,
          signupUrl: `${process.env.APP_URL || 'https://skillons.herokuapp.com'}/signup?code=${req.organization.subdomain}`
        });
      }
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
    const { studentName, email, gradeLevel, organizationCodes, subjects } = req.body;
    
    // Validate required fields
    if (!studentName || !email || !gradeLevel || !organizationCodes || organizationCodes.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please fill in all required fields and select at least one organization'
      });
    }
    
    // Ensure organizationCodes is an array
    const orgCodes = Array.isArray(organizationCodes) ? organizationCodes : [organizationCodes];
    
    // Find all organizations by subdomain
    const organizations = await Organization.find({ subdomain: { $in: orgCodes } });
    if (organizations.length !== orgCodes.length) {
      const foundCodes = organizations.map(org => org.subdomain);
      const invalidCodes = orgCodes.filter(code => !foundCodes.includes(code));
      return res.status(400).json({
        success: false,
        message: `Invalid organization code(s): ${invalidCodes.join(', ')}. Please check with your teacher.`
      });
    }
    
    // Check if user already exists with any of these organizations
    const existingUsers = await User.find({ 
      email: email,
      organizationId: { $in: organizations.map(org => org._id) }
    });
    
    if (existingUsers.length > 0) {
      const existingOrgNames = await Organization.find({ 
        _id: { $in: existingUsers.map(user => user.organizationId) } 
      }).select('name');
      return res.status(400).json({
        success: false,
        message: `You already have accounts with: ${existingOrgNames.map(org => org.name).join(', ')}`
      });
    }
    
    // Create temporary student users for each organization
    const tempUsers = [];
    const timestamp = Date.now();
    
    for (let i = 0; i < organizations.length; i++) {
      const org = organizations[i];
      const tempUser = new User({
        googleId: `temp_student_${timestamp}_${i}`,
        displayName: studentName,
        email: email,
        role: 'student',
        organizationId: org._id,
        organizationRole: 'student',
        gradeLevel: gradeLevel,
        subjects: subjects || [],
        isApproved: true, // Students are auto-approved
        invitationStatus: 'pending'
      });
      
      await tempUser.save();
      tempUsers.push(tempUser);
    }
    
    console.log('Temporary student users created:', {
      email: email,
      organizations: organizations.map(org => org.name),
      gradeLevel: gradeLevel,
      count: tempUsers.length
    });
    
    res.json({
      success: true,
      message: `Student accounts created successfully for ${organizations.length} organization(s)! Please sign in with Google.`,
      organizationNames: organizations.map(org => org.name),
      count: tempUsers.length
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