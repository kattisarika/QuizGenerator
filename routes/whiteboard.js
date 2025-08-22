const express = require('express');
const router = express.Router();
const WhiteboardSession = require('../models/WhiteboardSession');
const User = require('../models/User');

// Middleware functions (these should match the ones in server.js)
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
};

const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (roles.includes(req.user.role)) {
      return next();
    }

    res.status(403).json({ error: 'Insufficient permissions' });
  };
};

// Create new whiteboard session (Teachers only)
router.post('/create', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const {
      title,
      description,
      subject,
      gradeLevel,
      isPasswordProtected,
      password,
      settings
    } = req.body;

    // Validate required fields
    if (!title || !gradeLevel) {
      return res.status(400).json({
        error: 'Title and grade level are required'
      });
    }

    // Generate unique session ID and join code
    let sessionId, joinCode;
    let isUnique = false;
    
    while (!isUnique) {
      sessionId = WhiteboardSession.generateSessionId();
      joinCode = WhiteboardSession.generateJoinCode();
      
      const existing = await WhiteboardSession.findOne({
        $or: [{ sessionId }, { joinCode }]
      });
      
      if (!existing) {
        isUnique = true;
      }
    }

    // Create session
    const session = new WhiteboardSession({
      sessionId,
      joinCode,
      title,
      description,
      subject: subject || 'Other',
      gradeLevel,
      teacherId: req.user._id,
      teacherName: req.user.displayName,
      organizationId: req.user.organizationId,
      isPasswordProtected: isPasswordProtected || false,
      password: isPasswordProtected ? password : undefined,
      settings: {
        ...{
          maxParticipants: 50,
          allowStudentDrawing: false,
          allowStudentChat: true,
          allowStudentVoice: false,
          allowStudentVideo: false,
          autoAdmitStudents: false,
          recordSession: false
        },
        ...settings
      }
    });

    // Add teacher as first participant
    session.addParticipant({
      userId: req.user._id,
      name: req.user.displayName,
      email: req.user.email,
      role: 'teacher'
    });

    await session.save();

    res.json({
      success: true,
      session: {
        sessionId: session.sessionId,
        joinCode: session.joinCode,
        title: session.title,
        joinLink: session.generateJoinLink(),
        status: session.status
      }
    });

  } catch (error) {
    console.error('Error creating whiteboard session:', error);
    res.status(500).json({
      error: 'Failed to create whiteboard session'
    });
  }
});

// Get teacher's sessions
router.get('/my-sessions', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const sessions = await WhiteboardSession.find({
      teacherId: req.user._id
    })
    .select('sessionId joinCode title description subject gradeLevel status participants createdAt actualStartTime endTime')
    .sort({ createdAt: -1 })
    .limit(50);

    const sessionsWithStats = sessions.map(session => ({
      sessionId: session.sessionId,
      joinCode: session.joinCode,
      title: session.title,
      description: session.description,
      subject: session.subject,
      gradeLevel: session.gradeLevel,
      status: session.status,
      participantCount: session.participants.length,
      admittedCount: session.participants.filter(p => p.status === 'admitted').length,
      createdAt: session.createdAt,
      actualStartTime: session.actualStartTime,
      endTime: session.endTime,
      joinLink: session.generateJoinLink()
    }));

    res.json({
      success: true,
      sessions: sessionsWithStats
    });

  } catch (error) {
    console.error('Error fetching teacher sessions:', error);
    res.status(500).json({
      error: 'Failed to fetch sessions'
    });
  }
});

// Start session (Teachers only)
router.post('/:sessionId/start', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId,
      teacherId: req.user._id
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    if (session.status !== 'waiting') {
      return res.status(400).json({
        error: 'Session is already started or ended'
      });
    }

    session.status = 'active';
    session.actualStartTime = new Date();
    await session.save();

    res.json({
      success: true,
      message: 'Session started successfully',
      session: {
        sessionId: session.sessionId,
        status: session.status,
        startTime: session.actualStartTime
      }
    });

  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({
      error: 'Failed to start session'
    });
  }
});

// End session (Teachers only)
router.post('/:sessionId/end', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId,
      teacherId: req.user._id
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    if (session.status === 'ended') {
      return res.status(400).json({
        error: 'Session is already ended'
      });
    }

    session.status = 'ended';
    session.endTime = new Date();
    
    // Calculate duration if session was started
    if (session.actualStartTime) {
      session.duration = Math.round((session.endTime - session.actualStartTime) / (1000 * 60));
    }

    await session.save();

    res.json({
      success: true,
      message: 'Session ended successfully',
      session: {
        sessionId: session.sessionId,
        status: session.status,
        endTime: session.endTime,
        duration: session.duration
      }
    });

  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({
      error: 'Failed to end session'
    });
  }
});

// Join session (Students and Teachers)
router.post('/join/:sessionId', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    
    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId
    }).select('+password');

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    if (session.status === 'ended') {
      return res.status(400).json({
        error: 'This session has ended'
      });
    }

    // Check password if required
    if (session.isPasswordProtected && session.password !== password) {
      return res.status(401).json({
        error: 'Incorrect password'
      });
    }

    // Check if user is already a participant
    const existingParticipant = session.participants.find(p => 
      p.userId && p.userId.equals(req.user._id)
    );

    if (existingParticipant) {
      if (existingParticipant.status === 'denied' || existingParticipant.status === 'removed') {
        return res.status(403).json({
          error: 'You have been denied access to this session'
        });
      }

      // Update last active time
      existingParticipant.lastActive = new Date();
      await session.save();

      return res.json({
        success: true,
        message: 'Rejoined session successfully',
        participant: existingParticipant,
        session: {
          sessionId: session.sessionId,
          title: session.title,
          status: session.status,
          teacherName: session.teacherName
        }
      });
    }

    // Check participant limit
    const admittedCount = session.participants.filter(p => p.status === 'admitted').length;
    if (admittedCount >= session.settings.maxParticipants) {
      return res.status(400).json({
        error: 'Session is full'
      });
    }

    // Add new participant
    const participant = session.addParticipant({
      userId: req.user._id,
      name: req.user.displayName,
      email: req.user.email,
      role: req.user.role
    });

    await session.save();

    res.json({
      success: true,
      message: participant.status === 'admitted' ? 'Joined session successfully' : 'Waiting for teacher approval',
      participant,
      session: {
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        teacherName: session.teacherName
      }
    });

  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).json({
      error: 'Failed to join session'
    });
  }
});

// Join by code
router.post('/join-by-code', requireAuth, async (req, res) => {
  try {
    const { joinCode, password } = req.body;

    if (!joinCode) {
      return res.status(400).json({
        error: 'Join code is required'
      });
    }

    const session = await WhiteboardSession.findOne({
      joinCode: joinCode.toUpperCase()
    }).select('+password');

    if (!session) {
      return res.status(404).json({
        error: 'Invalid join code'
      });
    }

    if (session.status === 'ended') {
      return res.status(400).json({
        error: 'This session has ended'
      });
    }

    // Check password if required
    if (session.isPasswordProtected && session.password !== password) {
      return res.status(401).json({
        error: 'Incorrect password'
      });
    }

    // Check if user is already a participant
    const existingParticipant = session.participants.find(p =>
      p.userId && p.userId.equals(req.user._id)
    );

    if (existingParticipant) {
      if (existingParticipant.status === 'denied' || existingParticipant.status === 'removed') {
        return res.status(403).json({
          error: 'You have been denied access to this session'
        });
      }

      existingParticipant.lastActive = new Date();
      await session.save();

      return res.json({
        success: true,
        message: 'Rejoined session successfully',
        participant: existingParticipant,
        session: {
          sessionId: session.sessionId,
          title: session.title,
          status: session.status,
          teacherName: session.teacherName
        }
      });
    }

    // Check participant limit
    const admittedCount = session.participants.filter(p => p.status === 'admitted').length;
    if (admittedCount >= session.settings.maxParticipants) {
      return res.status(400).json({
        error: 'Session is full'
      });
    }

    // Add new participant
    const participant = session.addParticipant({
      userId: req.user._id,
      name: req.user.displayName,
      email: req.user.email,
      role: req.user.role
    });

    await session.save();

    res.json({
      success: true,
      message: participant.status === 'admitted' ? 'Joined session successfully' : 'Waiting for teacher approval',
      participant,
      session: {
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        teacherName: session.teacherName
      }
    });

  } catch (error) {
    console.error('Error joining by code:', error);
    res.status(500).json({
      error: 'Failed to join session'
    });
  }
});

// Get participant status
router.get('/status/:sessionId', requireAuth, async (req, res) => {
  try {
    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    const participant = session.participants.find(p =>
      p.userId && p.userId.equals(req.user._id)
    );

    if (!participant) {
      return res.status(404).json({
        error: 'You are not a participant in this session'
      });
    }

    res.json({
      success: true,
      participant: {
        status: participant.status,
        permissions: participant.permissions,
        joinedAt: participant.joinedAt
      },
      session: {
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        teacherName: session.teacherName
      }
    });

  } catch (error) {
    console.error('Error getting participant status:', error);
    res.status(500).json({
      error: 'Failed to get status'
    });
  }
});

// Admit/deny participants (Teachers only)
router.post('/:sessionId/participants/:userId/status', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const { status } = req.body; // 'admitted' or 'denied'

    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId,
      teacherId: req.user._id
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    const participant = session.updateParticipantStatus(req.params.userId, status);

    if (!participant) {
      return res.status(404).json({
        error: 'Participant not found'
      });
    }

    await session.save();

    res.json({
      success: true,
      message: `Participant ${status} successfully`,
      participant
    });

  } catch (error) {
    console.error('Error updating participant status:', error);
    res.status(500).json({
      error: 'Failed to update participant status'
    });
  }
});

// Get session participants (for real-time updates)
router.get('/:sessionId/participants', requireAuth, async (req, res) => {
  try {
    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user is a participant
    const userParticipant = session.participants.find(p =>
      p.userId && p.userId.equals(req.user._id)
    );

    if (!userParticipant && req.user.role !== 'teacher') {
      return res.status(403).json({
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      participants: session.participants.map(p => ({
        userId: p.userId,
        name: p.name,
        role: p.role,
        status: p.status,
        permissions: p.permissions,
        joinedAt: p.joinedAt,
        lastActive: p.lastActive
      }))
    });

  } catch (error) {
    console.error('Error getting participants:', error);
    res.status(500).json({
      error: 'Failed to get participants'
    });
  }
});

// Get session details
router.get('/:sessionId/details', requireAuth, async (req, res) => {
  try {
    const session = await WhiteboardSession.findOne({
      sessionId: req.params.sessionId
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user is a participant
    const userParticipant = session.participants.find(p =>
      p.userId && p.userId.equals(req.user._id)
    );

    if (!userParticipant && req.user.role !== 'teacher') {
      return res.status(403).json({
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      session: {
        sessionId: session.sessionId,
        title: session.title,
        description: session.description,
        subject: session.subject,
        gradeLevel: session.gradeLevel,
        teacherName: session.teacherName,
        status: session.status,
        participantCount: session.participants.length,
        admittedCount: session.participants.filter(p => p.status === 'admitted').length,
        createdAt: session.createdAt,
        actualStartTime: session.actualStartTime
      }
    });

  } catch (error) {
    console.error('Error getting session details:', error);
    res.status(500).json({
      error: 'Failed to get session details'
    });
  }
});

module.exports = router;
