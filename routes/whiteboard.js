const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Middleware
const { isAuthenticated, requireRole, requireApprovedTeacher } = require('../middleware/auth');
const { requireOrganization } = require('../middleware/tenancy');

// Models
const WhiteboardSession = require('../models/Whiteboard');
const User = require('../models/User');
const Organization = require('../models/Organization');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/whiteboard';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, PDFs, and PowerPoint files are allowed.'), false);
    }
  }
});

/**
 * GET /whiteboard
 * Whiteboard dashboard for teachers
 */
router.get('/whiteboard', 
  isAuthenticated, 
  requireRole(['teacher']), 
  requireApprovedTeacher,
  async (req, res) => {
    try {
      const activeSessions = await WhiteboardSession.findActiveByTeacher(req.user._id);
      const archivedSessions = await WhiteboardSession.find({
        teacher: req.user._id,
        status: { $in: ['ended', 'archived'] }
      }).populate('participants.user', 'displayName').sort({ createdAt: -1 }).limit(10);

      res.render('whiteboard-dashboard', {
        title: 'Whiteboard Dashboard',
        user: req.user,
        activeSessions,
        archivedSessions
      });
    } catch (error) {
      console.error('Error loading whiteboard dashboard:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to load whiteboard dashboard',
        error: { status: 500 }
      });
    }
  }
);

/**
 * GET /whiteboard/create
 * Create new whiteboard session page
 */
router.get('/whiteboard/create', 
  isAuthenticated, 
  requireRole(['teacher']), 
  requireApprovedTeacher,
  (req, res) => {
    res.render('create-whiteboard', {
      title: 'Create Whiteboard Session',
      user: req.user
    });
  }
);

/**
 * POST /api/whiteboard/create
 * Create new whiteboard session
 */
router.post('/api/whiteboard/create', 
  isAuthenticated, 
  requireRole(['teacher']), 
  requireApprovedTeacher,
  async (req, res) => {
    try {
      const { title, description, gradeLevel, subject, sessionMode, collaborationSettings } = req.body;
      
      // Validate required fields
      if (!title || !gradeLevel || !subject) {
        return res.status(400).json({ 
          success: false, 
          error: 'Title, grade level, and subject are required' 
        });
      }

      // Create whiteboard session
      const whiteboardSession = new WhiteboardSession({
        title,
        description,
        gradeLevel,
        subject,
        teacher: req.user._id,
        organizationId: req.user.organizationId,
        sessionMode: sessionMode || 'live',
        collaborationSettings: collaborationSettings || {
          studentWritingEnabled: false,
          studentDrawingEnabled: false,
          maxActiveStudents: 5
        },
        boardContent: {
          pages: [{
            pageNumber: 1,
            elements: [],
            background: '#ffffff',
            zoom: 1,
            pan: { x: 0, y: 0 }
          }],
          currentPage: 1
        }
      });

      // Add teacher as first participant
      await whiteboardSession.addParticipant(req.user._id, 'teacher', {
        canWrite: true,
        canDraw: true,
        canErase: true
      });

      await whiteboardSession.save();

      res.json({
        success: true,
        sessionId: whiteboardSession._id,
        message: 'Whiteboard session created successfully'
      });
    } catch (error) {
      console.error('Error creating whiteboard session:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to create whiteboard session' 
      });
    }
  }
);

/**
 * GET /whiteboard/:id
 * Join whiteboard session
 */
router.get('/whiteboard/:id', 
  isAuthenticated, 
  async (req, res) => {
    try {
      const session = await WhiteboardSession.findById(req.params.id)
        .populate('teacher', 'displayName')
        .populate('participants.user', 'displayName role')
        .populate('organizationId', 'name');

      if (!session) {
        return res.status(404).render('error', {
          title: 'Not Found',
          message: 'Whiteboard session not found',
          error: { status: 404 }
        });
      }

      // Check if user has access
      const isParticipant = session.participants.some(p => p.user._id.toString() === req.user._id.toString());
      const isTeacher = session.teacher._id.toString() === req.user._id.toString();
      const isStudent = req.user.role === 'student';

      if (!isParticipant && !isTeacher && !isStudent) {
        return res.status(403).render('error', {
          title: 'Access Denied',
          message: 'You do not have access to this whiteboard session',
          error: { status: 403 }
        });
      }

      // Add user as participant if not already
      if (!isParticipant) {
        await session.addParticipant(req.user._id, req.user.role, {
          canWrite: isTeacher || session.collaborationSettings.studentWritingEnabled,
          canDraw: isTeacher || session.collaborationSettings.studentDrawingEnabled,
          canErase: isTeacher
        });
      }

      res.render('whiteboard-session', {
        title: session.title,
        user: req.user,
        session,
        isTeacher,
        isParticipant
      });
    } catch (error) {
      console.error('Error joining whiteboard session:', error);
      res.status(500).render('error', {
        title: 'Error',
        message: 'Failed to join whiteboard session',
        error: { status: 500 }
      });
    }
  }
);

/**
 * POST /api/whiteboard/:id/upload
 * Upload file to whiteboard session
 */
router.post('/api/whiteboard/:id/upload', 
  isAuthenticated, 
  requireRole(['teacher']), 
  requireApprovedTeacher,
  upload.single('file'),
  async (req, res) => {
    try {
      const session = await WhiteboardSession.findById(req.params.id);
      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      if (session.teacher.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }

      // Add file to session
      session.uploadedFiles.push({
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        url: `/uploads/whiteboard/${req.file.filename}`
      });

      await session.save();

      res.json({
        success: true,
        file: {
          filename: req.file.filename,
          originalName: req.file.originalname,
          url: `/uploads/whiteboard/${req.file.filename}`
        },
        message: 'File uploaded successfully'
      });
    } catch (error) {
      console.error('Error uploading file:', error);
      res.status(500).json({ success: false, error: 'Failed to upload file' });
    }
  }
);

/**
 * POST /api/whiteboard/:id/element
 * Add element to whiteboard
 */
router.post('/api/whiteboard/:id/element', 
  isAuthenticated, 
  async (req, res) => {
    try {
      const { pageNumber, elementData } = req.body;
      const session = await WhiteboardSession.findById(req.params.id);

      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      // Check permissions
      const participant = session.participants.find(p => p.user.toString() === req.user._id.toString());
      if (!participant) {
        return res.status(403).json({ success: false, error: 'Not a participant' });
      }

      if (elementData.type === 'path' && !participant.permissions.canDraw) {
        return res.status(403).json({ success: false, error: 'Drawing not allowed' });
      }

      if (elementData.type === 'text' && !participant.permissions.canWrite) {
        return res.status(403).json({ success: false, error: 'Writing not allowed' });
      }

      // Add element
      await session.addElement(pageNumber, elementData, req.user._id);

      res.json({
        success: true,
        message: 'Element added successfully'
      });
    } catch (error) {
      console.error('Error adding element:', error);
      res.status(500).json({ success: false, error: 'Failed to add element' });
    }
  }
);

/**
 * POST /api/whiteboard/:id/snapshot
 * Take snapshot of current board
 */
router.post('/api/whiteboard/:id/snapshot', 
  isAuthenticated, 
  requireRole(['teacher']), 
  requireApprovedTeacher,
  async (req, res) => {
    try {
      const { pageNumber, name, description } = req.body;
      const session = await WhiteboardSession.findById(req.params.id);

      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      if (session.teacher.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      // Take snapshot
      await session.takeSnapshot(pageNumber, name, description);

      res.json({
        success: true,
        message: 'Snapshot taken successfully'
      });
    } catch (error) {
      console.error('Error taking snapshot:', error);
      res.status(500).json({ success: false, error: 'Failed to take snapshot' });
    }
  }
);

/**
 * PUT /api/whiteboard/:id/status
 * Update session status
 */
router.put('/api/whiteboard/:id/status', 
  isAuthenticated, 
  requireRole(['teacher']), 
  requireApprovedTeacher,
  async (req, res) => {
    try {
      const { status } = req.body;
      const session = await WhiteboardSession.findById(req.params.id);

      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      if (session.teacher.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      session.status = status;
      if (status === 'ended') {
        session.endedAt = new Date();
      }

      await session.save();

      res.json({
        success: true,
        message: 'Session status updated successfully'
      });
    } catch (error) {
      console.error('Error updating session status:', error);
      res.status(500).json({ success: false, error: 'Failed to update status' });
    }
  }
);

/**
 * GET /api/whiteboard/student/sessions
 * Get available whiteboard sessions for students
 */
router.get('/api/whiteboard/student/sessions', 
  isAuthenticated, 
  requireRole(['student']), 
  async (req, res) => {
    try {
      const { grade, subject } = req.query;
      
      let query = {
        organizationId: req.user.organizationId,
        status: { $in: ['ended', 'archived'] },
        isPublic: true
      };

      if (grade && grade !== 'all') {
        query.gradeLevel = grade;
      }

      if (subject && subject !== 'all') {
        query.subject = subject;
      }

      const sessions = await WhiteboardSession.find(query)
        .populate('teacher', 'displayName')
        .sort({ createdAt: -1 });

      res.json({
        success: true,
        sessions
      });
    } catch (error) {
      console.error('Error fetching student whiteboard sessions:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch sessions' });
    }
  }
);

/**
 * GET /api/whiteboard/:id/export
 * Export whiteboard session as image/PDF
 */
router.get('/api/whiteboard/:id/export', 
  isAuthenticated, 
  async (req, res) => {
    try {
      const { format = 'png' } = req.query;
      const session = await WhiteboardSession.findById(req.params.id);

      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      // Check access
      const isParticipant = session.participants.some(p => p.user.toString() === req.user._id.toString());
      const isTeacher = session.teacher.toString() === req.user._id.toString();

      if (!isParticipant && !isTeacher) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      // For now, return session data for client-side export
      // In production, you'd implement server-side image/PDF generation
      res.json({
        success: true,
        session: {
          title: session.title,
          description: session.description,
          boardContent: session.boardContent,
          snapshots: session.snapshots
        },
        message: 'Export data retrieved successfully'
      });
    } catch (error) {
      console.error('Error exporting whiteboard session:', error);
      res.status(500).json({ success: false, error: 'Failed to export session' });
    }
  }
);

module.exports = router; 