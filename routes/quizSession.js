const express = require('express');
const router = express.Router();
const QuizSession = require('../models/QuizSession');
const Quiz = require('../models/Quiz');
const QuizResult = require('../models/QuizResult');
// Authentication middleware functions are defined in server.js
// We'll access them through the app context, but for now let's create local versions
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  } else {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
};

const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    next();
  };
};

// Helper function to emit real-time updates
function emitSessionUpdate(io, sessionId, updateType, data) {
  if (io) {
    io.to(`session-${sessionId}`).emit(updateType, data);
  }
}

// Create a new competitive quiz session
router.post('/create', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    console.log('=== CREATING QUIZ SESSION ===');
    console.log('Teacher:', req.user.displayName, '(', req.user.email, ')');
    console.log('Organization ID:', req.user.organizationId);
    
    const { quizId, duration, maxParticipants, settings } = req.body;
    console.log('Session request:', { quizId, duration, maxParticipants, settings });
    
    // Validate quiz exists and belongs to teacher's organization
    const quiz = await Quiz.findOne({ 
      _id: quizId, 
      organizationId: req.user.organizationId
    });
    
    console.log('Quiz found:', quiz ? `"${quiz.title}" (${quiz.questions.length} questions)` : 'NOT FOUND');
    
    if (!quiz) {
      console.log('❌ Quiz not found or does not belong to teacher\'s organization');
      return res.status(404).json({ success: false, message: 'Quiz not found or access denied' });
    }
    
    // Generate unique session code
    let sessionCode;
    let codeExists = true;
    while (codeExists) {
      sessionCode = QuizSession.generateSessionCode();
      const existing = await QuizSession.findOne({ sessionCode });
      codeExists = !!existing;
    }
    
    const session = new QuizSession({
      quiz: quizId,
      quizTitle: quiz.title,
      teacher: req.user._id,
      teacherName: req.user.displayName,
      organizationId: req.user.organizationId,
      sessionCode,
      duration: duration || 30,
      maxParticipants: maxParticipants || 50,
      settings: settings || {}
    });
    
    await session.save();
    console.log('✅ Quiz session created successfully!');
    console.log('Session Code:', sessionCode);
    console.log('Session ID:', session._id);
    
    res.json({ 
      success: true, 
      session: {
        id: session._id,
        sessionCode,
        quizTitle: quiz.title,
        status: session.status
      }
    });
    
  } catch (error) {
    console.error('Error creating quiz session:', error);
    res.status(500).json({ success: false, message: 'Error creating session' });
  }
});

// Join a quiz session
router.post('/join/:sessionCode', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    const session = await QuizSession.findOne({ sessionCode })
      .populate('quiz', 'title questions')
      .populate('organizationId', 'name');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Check if session is still accepting participants
    if (session.status === 'completed' || session.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Session has ended' });
    }
    
    if (session.status === 'active' && !session.settings.allowLateJoin) {
      return res.status(400).json({ success: false, message: 'Session has already started' });
    }
    
    // Check organization membership
    const hasAccess = req.user.organizationId?.toString() === session.organizationId._id.toString() ||
      req.user.organizationMemberships?.some(m => m.organizationId.toString() === session.organizationId._id.toString());
    
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied to this session' });
    }
    
    // Add participant to session
    console.log('Adding participant:', req.user.displayName, 'to session');
    await session.addParticipant(req.user._id, req.user.displayName);
    
    // Refresh session data after adding participant
    await session.populate('participants');
    console.log('Session participants after adding:', session.participants.length);
    console.log('Participant details:', session.participants.map(p => ({ name: p.studentName, joinedAt: p.joinedAt })));
    
    // Emit real-time update
    if (req.app.get('io')) {
      emitSessionUpdate(req.app.get('io'), session._id, 'participant-joined', {
        participantCount: session.participants.length,
        newParticipant: {
          name: req.user.displayName,
          joinedAt: new Date()
        }
      });
    }
    
    res.json({ 
      success: true, 
      session: {
        id: session._id,
        quizTitle: session.quizTitle,
        status: session.status,
        participantCount: session.participants.length,
        settings: session.settings
      }
    });
    
  } catch (error) {
    console.error('Error joining quiz session:', error);
    res.status(500).json({ success: false, message: error.message || 'Error joining session' });
  }
});

// Start a quiz session
router.post('/:sessionId/start', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const session = await QuizSession.findOne({ 
      _id: req.params.sessionId,
      teacher: req.user._id 
    });
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    if (session.participants.length === 0) {
      return res.status(400).json({ success: false, message: 'No participants in session' });
    }
    
    session.status = 'active';
    session.startTime = new Date();
    
    // Mark all participants as in-progress
    session.participants.forEach(p => {
      if (p.status === 'joined') {
        p.status = 'in-progress';
        p.startedAt = new Date();
      }
    });
    
    await session.save();
    
    // Emit real-time update to all participants
    if (req.app.get('io')) {
      emitSessionUpdate(req.app.get('io'), session._id, 'session-started', {
        startTime: session.startTime,
        duration: session.duration
      });
    }
    
    res.json({ success: true, message: 'Session started successfully' });
    
  } catch (error) {
    console.error('Error starting quiz session:', error);
    res.status(500).json({ success: false, message: 'Error starting session' });
  }
});

// Get session details
router.get('/:sessionId', isAuthenticated, async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId)
      .populate('quiz', 'title questions')
      .populate('teacher', 'displayName')
      .populate('organizationId', 'name');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Check access permissions
    const isTeacher = session.teacher._id.toString() === req.user._id.toString();
    const isParticipant = session.participants.some(p => p.student.toString() === req.user._id.toString());
    
    if (!isTeacher && !isParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    res.json({ 
      success: true, 
      session: {
        id: session._id,
        sessionCode: session.sessionCode,
        quizTitle: session.quizTitle,
        teacherName: session.teacherName,
        status: session.status,
        participantCount: session.participants.length,
        maxParticipants: session.maxParticipants,
        duration: session.duration,
        startTime: session.startTime,
        settings: session.settings,
        participants: session.participants.map(p => ({
          name: p.studentName,
          status: p.status,
          currentQuestion: p.currentQuestion,
          answersSubmitted: p.answersSubmitted,
          score: p.score,
          percentage: p.percentage,
          timeTaken: p.timeTaken
        }))
      }
    });
    
  } catch (error) {
    console.error('Error getting session details:', error);
    res.status(500).json({ success: false, message: 'Error getting session details' });
  }
});

// Get live leaderboard
router.get('/:sessionId/leaderboard', isAuthenticated, async (req, res) => {
  try {
    const leaderboard = await QuizSession.getLeaderboard(req.params.sessionId);
    
    if (!leaderboard) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    res.json({ success: true, leaderboard });
    
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    res.status(500).json({ success: false, message: 'Error getting leaderboard' });
  }
});

// Update participant progress
router.post('/:sessionId/progress', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { currentQuestion, answersSubmitted, timeTaken } = req.body;
    
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    await session.updateParticipantProgress(req.user._id, {
      currentQuestion,
      answersSubmitted,
      timeTaken,
      status: 'in-progress'
    });
    
    // Emit real-time update
    if (req.app.get('io')) {
      emitSessionUpdate(req.app.get('io'), session._id, 'progress-update', {
        studentName: req.user.displayName,
        currentQuestion,
        answersSubmitted,
        participantCount: session.participants.length
      });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({ success: false, message: 'Error updating progress' });
  }
});

// Complete participation in session
router.post('/:sessionId/complete', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { score, percentage, timeTaken } = req.body;
    
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    await session.updateParticipantProgress(req.user._id, {
      score,
      percentage,
      timeTaken,
      completedAt: new Date(),
      status: 'completed'
    });
    
    // Emit real-time update
    if (req.app.get('io')) {
      emitSessionUpdate(req.app.get('io'), session._id, 'participant-completed', {
        studentName: req.user.displayName,
        score,
        percentage,
        timeTaken,
        completedCount: session.participants.filter(p => p.status === 'completed').length + 1
      });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error completing session:', error);
    res.status(500).json({ success: false, message: 'Error completing session' });
  }
});

// Get teacher's sessions
router.get('/teacher/my-sessions', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const sessions = await QuizSession.find({
      teacher: req.user._id,
      organizationId: req.user.organizationId
    }).populate('quiz', 'title').sort({ createdAt: -1 });
    
    res.json({ success: true, sessions });
    
  } catch (error) {
    console.error('Error getting teacher sessions:', error);
    res.status(500).json({ success: false, message: 'Error getting sessions' });
  }
});

// Update participant progress (when they answer a question)
router.post('/:sessionId/progress', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { questionIndex, selectedAnswer, timeTaken, isCorrect } = req.body;
    
    const session = await QuizSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Find the participant
    const participant = session.participants.find(p => p.student.toString() === req.user._id.toString());
    if (!participant) {
      return res.status(403).json({ success: false, message: 'Not authorized for this session' });
    }
    
    // Update question progress
    participant.questionProgress.push({
      questionIndex,
      answeredAt: new Date(),
      timeTakenForQuestion: timeTaken,
      isCorrect,
      selectedAnswer
    });
    
    // Update overall progress
    participant.currentQuestion = Math.max(participant.currentQuestion, questionIndex + 1);
    participant.answersSubmitted = participant.questionProgress.length;
    participant.lastActivity = new Date();
    
    // Calculate current score
    const correctAnswers = participant.questionProgress.filter(q => q.isCorrect).length;
    participant.score = correctAnswers;
    participant.percentage = (correctAnswers / session.quiz.questions.length) * 100;
    
    await session.save();
    
    // Emit real-time update to all participants and teacher
    const progressData = {
      studentId: req.user._id,
      studentName: participant.studentName,
      questionIndex,
      timeTaken,
      isCorrect,
      currentScore: participant.score,
      totalQuestions: session.quiz.questions.length,
      percentage: participant.percentage
    };
    
    if (req.app.get('io')) {
      emitSessionUpdate(req.app.get('io'), sessionId, 'question-answered', progressData);
    }
    
    res.json({ success: true, progress: progressData });
    
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({ success: false, message: 'Error updating progress' });
  }
});

// Mark participant as completed
router.post('/:sessionId/complete', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { totalTimeTaken } = req.body;
    
    const session = await QuizSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Find the participant
    const participant = session.participants.find(p => p.student.toString() === req.user._id.toString());
    if (!participant) {
      return res.status(403).json({ success: false, message: 'Not authorized for this session' });
    }
    
    // Mark as completed
    participant.status = 'completed';
    participant.completedAt = new Date();
    participant.timeTaken = totalTimeTaken;
    
    await session.save();
    
    // Check if this was the last participant to finish
    const completedCount = session.participants.filter(p => p.status === 'completed').length;
    const totalParticipants = session.participants.length;
    
    // Create final leaderboard
    const leaderboard = session.participants
      .filter(p => p.status === 'completed')
      .sort((a, b) => {
        // Sort by score first (descending), then by time (ascending)
        if (a.score !== b.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      })
      .map((p, index) => ({
        rank: index + 1,
        studentName: p.studentName,
        score: p.score,
        timeTaken: p.timeTaken,
        percentage: p.percentage,
        isWinner: index === 0
      }));
    
    // Emit completion update
    const completionData = {
      studentId: req.user._id,
      studentName: participant.studentName,
      finalScore: participant.score,
      timeTaken: participant.timeTaken,
      completedCount,
      totalParticipants,
      leaderboard
    };
    
    if (req.app.get('io')) {
      emitSessionUpdate(req.app.get('io'), sessionId, 'participant-completed', completionData);
      
      // If everyone finished, announce winner
      if (completedCount === totalParticipants) {
        const winner = leaderboard[0];
        emitSessionUpdate(req.app.get('io'), sessionId, 'quiz-finished', {
          winner,
          finalLeaderboard: leaderboard
        });
      }
    }
    
    res.json({ success: true, leaderboard, rank: leaderboard.find(l => l.studentName === participant.studentName)?.rank });
    
  } catch (error) {
    console.error('Error completing quiz:', error);
    res.status(500).json({ success: false, message: 'Error completing quiz' });
  }
});

// Get current leaderboard
router.get('/:sessionId/leaderboard', isAuthenticated, async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId).populate('quiz');
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    console.log('Leaderboard request for session:', req.params.sessionId);
    console.log('Session found with', session.participants.length, 'participants');
    console.log('Session status:', session.status);
    console.log('Session participants:', session.participants.map(p => ({ 
      studentName: p.studentName, 
      status: p.status, 
      joinedAt: p.joinedAt 
    })));
    
    // Create live leaderboard
    const leaderboard = session.participants
      .map(p => ({
        studentName: p.studentName,
        score: p.score,
        currentQuestion: p.currentQuestion,
        status: p.status,
        timeTaken: p.timeTaken,
        percentage: p.percentage,
        lastActivity: p.lastActivity
      }))
      .sort((a, b) => {
        // Sort by score first (descending), then by current question (descending), then by time (ascending)
        if (a.score !== b.score) return b.score - a.score;
        if (a.currentQuestion !== b.currentQuestion) return b.currentQuestion - a.currentQuestion;
        return a.timeTaken - b.timeTaken;
      });
    
    const responseData = { 
      success: true, 
      leaderboard, 
      participants: session.participants.length,
      sessionId: session._id,
      status: session.status
    };
    
    console.log('Sending leaderboard response:', {
      participantCount: session.participants.length,
      leaderboardEntries: leaderboard.length
    });
    
    res.json(responseData);
    
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    res.status(500).json({ success: false, message: 'Error getting leaderboard' });
  }
});

module.exports = router;