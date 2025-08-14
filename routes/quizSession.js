const express = require('express');
const router = express.Router();
const QuizSession = require('../models/QuizSession');
const Quiz = require('../models/Quiz');
const { isAuthenticated, requireRole } = require('../middleware/auth');

// Create a new competitive quiz session (Teacher)
router.post('/create-session', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const { quizId, scheduledStartTime, duration, maxParticipants, settings } = req.body;
    
    // Verify quiz exists and is competitive
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }
    
    if (quiz.quizType !== 'competitive') {
      return res.status(400).json({ success: false, message: 'Only competitive quizzes can have sessions' });
    }
    
    // Verify teacher owns the quiz
    if (quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only create sessions for your own quizzes' });
    }
    
    // Generate unique session code
    let sessionCode;
    let codeExists = true;
    while (codeExists) {
      sessionCode = QuizSession.generateSessionCode();
      const existing = await QuizSession.findOne({ sessionCode });
      codeExists = !!existing;
    }
    
    // Create session
    const session = new QuizSession({
      quiz: quizId,
      quizTitle: quiz.title,
      teacher: req.user._id,
      organizationId: req.user.organizationId,
      sessionCode,
      scheduledStartTime: new Date(scheduledStartTime),
      duration: duration || 30,
      maxParticipants: maxParticipants || 100,
      settings: settings || {}
    });
    
    await session.save();
    
    res.json({
      success: true,
      session: {
        id: session._id,
        sessionCode: session.sessionCode,
        scheduledStartTime: session.scheduledStartTime,
        status: session.status
      }
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ success: false, message: 'Error creating session' });
  }
});

// Get session details
router.get('/session/:sessionId', isAuthenticated, async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId)
      .populate('quiz')
      .populate('teacher', 'displayName email');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    res.json({
      success: true,
      session: {
        id: session._id,
        sessionCode: session.sessionCode,
        quizTitle: session.quizTitle,
        teacher: session.teacher,
        scheduledStartTime: session.scheduledStartTime,
        duration: session.duration,
        status: session.status,
        participantCount: session.participants.length,
        maxParticipants: session.maxParticipants,
        settings: session.settings,
        canStart: session.canStart()
      }
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ success: false, message: 'Error fetching session' });
  }
});

// Join session (Student)
router.post('/join/:sessionCode', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const session = await QuizSession.findOne({ sessionCode: req.params.sessionCode })
      .populate('quiz');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Check if session is joinable
    if (session.status === 'completed' || session.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This session has ended' });
    }
    
    // Check if late join is allowed
    if (session.status === 'in-progress' && !session.settings.allowLateJoin) {
      return res.status(400).json({ success: false, message: 'Session already started, late join not allowed' });
    }
    
    // Add participant
    try {
      session.addParticipant(req.user._id, req.user.displayName);
      await session.save();
      
      res.json({
        success: true,
        session: {
          id: session._id,
          quizId: session.quiz._id,
          quizTitle: session.quizTitle,
          status: session.status,
          scheduledStartTime: session.scheduledStartTime,
          settings: session.settings
        }
      });
    } catch (error) {
      if (error.message === 'Session is full') {
        return res.status(400).json({ success: false, message: 'Session is full' });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).json({ success: false, message: 'Error joining session' });
  }
});

// Start session (Teacher)
router.post('/start/:sessionId', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Verify teacher owns the session
    if (session.teacher.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only the session creator can start it' });
    }
    
    // Check if session can start
    if (!session.canStart()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Session cannot be started yet. Please wait until 5 minutes before scheduled time.' 
      });
    }
    
    // Start the session
    session.start();
    await session.save();
    
    res.json({
      success: true,
      message: 'Session started successfully',
      actualStartTime: session.actualStartTime
    });
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ success: false, message: 'Error starting session' });
  }
});

// Submit answer (Student)
router.post('/submit-answer/:sessionId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { questionIndex, selectedAnswer } = req.body;
    const session = await QuizSession.findById(req.params.sessionId).populate('quiz');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    if (session.status !== 'in-progress') {
      return res.status(400).json({ success: false, message: 'Session is not active' });
    }
    
    // Find participant
    const participant = session.participants.find(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (!participant) {
      return res.status(403).json({ success: false, message: 'You are not part of this session' });
    }
    
    // Check answer
    const question = session.quiz.questions[questionIndex];
    const isCorrect = selectedAnswer === question.correctAnswer;
    
    // Update participant's answers
    participant.answers.push({
      questionIndex,
      selectedAnswer,
      isCorrect,
      answeredAt: new Date()
    });
    
    // Update statistics
    participant.totalAnswers++;
    if (isCorrect) {
      participant.correctAnswers++;
      participant.score += question.points || 1;
    }
    participant.accuracy = (participant.correctAnswers / participant.totalAnswers) * 100;
    
    await session.save();
    
    res.json({
      success: true,
      isCorrect,
      currentScore: participant.score,
      accuracy: participant.accuracy
    });
  } catch (error) {
    console.error('Error submitting answer:', error);
    res.status(500).json({ success: false, message: 'Error submitting answer' });
  }
});

// Complete quiz (Student)
router.post('/complete/:sessionId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Find participant
    const participant = session.participants.find(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (!participant) {
      return res.status(403).json({ success: false, message: 'You are not part of this session' });
    }
    
    // Mark as completed
    participant.status = 'completed';
    participant.completedAt = new Date();
    
    // Calculate time taken
    if (participant.startedAt) {
      participant.timeTaken = Math.floor((participant.completedAt - participant.startedAt) / 1000);
    }
    
    // Update leaderboard
    session.updateLeaderboard();
    await session.save();
    
    res.json({
      success: true,
      results: {
        score: participant.score,
        correctAnswers: participant.correctAnswers,
        totalQuestions: session.quiz.questions.length,
        accuracy: participant.accuracy,
        timeTaken: participant.timeTaken,
        rank: session.leaderboard.findIndex(l => l.studentId.toString() === req.user._id.toString()) + 1
      }
    });
  } catch (error) {
    console.error('Error completing quiz:', error);
    res.status(500).json({ success: false, message: 'Error completing quiz' });
  }
});

// Get leaderboard
router.get('/leaderboard/:sessionId', isAuthenticated, async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Update leaderboard before sending
    session.updateLeaderboard();
    
    res.json({
      success: true,
      leaderboard: session.leaderboard,
      totalParticipants: session.participants.length,
      completedCount: session.participants.filter(p => p.status === 'completed').length
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, message: 'Error fetching leaderboard' });
  }
});

// Get live participants status (Teacher)
router.get('/participants/:sessionId', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Verify teacher owns the session
    if (session.teacher.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only the session creator can view participants' });
    }
    
    const participantStats = session.participants.map(p => ({
      studentName: p.studentName,
      status: p.status,
      joinedAt: p.joinedAt,
      correctAnswers: p.correctAnswers,
      totalAnswers: p.totalAnswers,
      accuracy: p.accuracy,
      timeTaken: p.timeTaken
    }));
    
    res.json({
      success: true,
      participants: participantStats,
      summary: {
        total: session.participants.length,
        waiting: session.participants.filter(p => p.status === 'waiting').length,
        inProgress: session.participants.filter(p => p.status === 'in-progress').length,
        completed: session.participants.filter(p => p.status === 'completed').length
      }
    });
  } catch (error) {
    console.error('Error fetching participants:', error);
    res.status(500).json({ success: false, message: 'Error fetching participants' });
  }
});

// End session (Teacher)
router.post('/end/:sessionId', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Verify teacher owns the session
    if (session.teacher.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only the session creator can end it' });
    }
    
    // End the session
    session.end();
    await session.save();
    
    res.json({
      success: true,
      message: 'Session ended successfully',
      finalLeaderboard: session.leaderboard
    });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ success: false, message: 'Error ending session' });
  }
});

module.exports = router;