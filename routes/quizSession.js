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
    // First find the session without populate to check conditions
    let session = await QuizSession.findOne({ sessionCode: req.params.sessionCode });
    
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
    
    // Check if already joined
    const existingParticipant = session.participants.find(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (existingParticipant) {
      // Check if already completed
      if (existingParticipant.status === 'completed') {
        return res.status(400).json({ 
          success: false, 
          message: 'You have already completed this quiz session. Each session can only be taken once.' 
        });
      }
      
      // Already joined but not completed, allow to continue
      await session.populate('quiz');
      return res.json({
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
    }
    
    // Check if session is full
    if (session.participants.length >= session.maxParticipants) {
      return res.status(400).json({ success: false, message: 'Session is full' });
    }
    
    // Add participant using atomic update
    const newParticipant = {
      student: req.user._id,
      studentName: req.user.displayName,
      joinedAt: new Date(),
      status: 'waiting'
    };
    
    // Use findOneAndUpdate with $push for atomic operation
    session = await QuizSession.findOneAndUpdate(
      { 
        sessionCode: req.params.sessionCode,
        'participants.student': { $ne: req.user._id } // Double-check not already added
      },
      { 
        $push: { participants: newParticipant }
      },
      { 
        new: true,
        runValidators: false // Skip validation to avoid the scheduledStartTime issue
      }
    ).populate('quiz');
    
    if (!session) {
      // Either session not found or participant already exists
      return res.status(400).json({ success: false, message: 'Unable to join session' });
    }
    
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
    
    // Use atomic update to start the session
    const actualStartTime = new Date();
    const updateQuery = {
      $set: {
        status: 'in-progress',
        actualStartTime: actualStartTime,
        'participants.$[elem].status': 'in-progress',
        'participants.$[elem].startedAt': actualStartTime
      }
    };
    
    const updateOptions = {
      arrayFilters: [{ 'elem.status': 'waiting' }],
      runValidators: false
    };
    
    await QuizSession.findByIdAndUpdate(
      req.params.sessionId,
      updateQuery,
      updateOptions
    );
    
    res.json({
      success: true,
      message: 'Session started successfully',
      actualStartTime: actualStartTime
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
    
    // Find participant index
    const participantIndex = session.participants.findIndex(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (participantIndex === -1) {
      return res.status(403).json({ success: false, message: 'You are not part of this session' });
    }
    
    // Check answer
    const question = session.quiz.questions[questionIndex];
    const isCorrect = selectedAnswer === question.correctAnswer;
    const points = question.points || 1;
    
    // Get current participant data
    const participant = session.participants[participantIndex];
    const newTotalAnswers = (participant.totalAnswers || 0) + 1;
    const newCorrectAnswers = (participant.correctAnswers || 0) + (isCorrect ? 1 : 0);
    const newScore = (participant.score || 0) + (isCorrect ? points : 0);
    const newAccuracy = (newCorrectAnswers / newTotalAnswers) * 100;
    
    // Prepare the answer object
    const newAnswer = {
      questionIndex,
      selectedAnswer,
      isCorrect,
      answeredAt: new Date()
    };
    
    // Use atomic update to avoid validation issues
    const updatePath = `participants.${participantIndex}`;
    const updateQuery = {
      $push: { [`${updatePath}.answers`]: newAnswer },
      $set: {
        [`${updatePath}.totalAnswers`]: newTotalAnswers,
        [`${updatePath}.correctAnswers`]: newCorrectAnswers,
        [`${updatePath}.score`]: newScore,
        [`${updatePath}.accuracy`]: newAccuracy
      }
    };
    
    await QuizSession.findByIdAndUpdate(
      req.params.sessionId,
      updateQuery,
      { runValidators: false }
    );
    
    res.json({
      success: true,
      isCorrect,
      currentScore: newScore,
      accuracy: newAccuracy
    });
  } catch (error) {
    console.error('Error submitting answer:', error);
    res.status(500).json({ success: false, message: 'Error submitting answer' });
  }
});

// Submit all answers and complete quiz (Student)
router.post('/submit-complete/:sessionId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { answers } = req.body;
    const session = await QuizSession.findById(req.params.sessionId).populate('quiz');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    if (session.status !== 'in-progress') {
      return res.status(400).json({ success: false, message: 'Session is not active' });
    }
    
    // Find participant index
    const participantIndex = session.participants.findIndex(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (participantIndex === -1) {
      return res.status(403).json({ success: false, message: 'You are not part of this session' });
    }
    
    const participant = session.participants[participantIndex];
    
    // Check if already completed
    if (participant.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        message: 'You have already completed this quiz session' 
      });
    }
    
    const completedAt = new Date();
    let timeTaken = 0;
    
    // Calculate time taken
    if (participant.startedAt) {
      timeTaken = Math.floor((completedAt - participant.startedAt) / 1000);
    }
    
    // Process all answers and calculate score
    let correctAnswers = 0;
    let totalAnswers = 0;
    let score = 0;
    const processedAnswers = [];
    
    // Convert answers object to array if needed
    const answersArray = Array.isArray(answers) ? answers : Object.values(answers);
    
    answersArray.forEach((answer, index) => {
      if (answer && (answer.selectedAnswer || answer.textAnswer)) {
        totalAnswers++;
        const question = session.quiz.questions[index];
        let isCorrect = false;
        let studentAnswer = '';

        if (answer.selectedAnswer) {
          // Multiple choice answer
          studentAnswer = answer.selectedAnswer;
          isCorrect = answer.selectedAnswer === question.correctAnswer;
        } else if (answer.textAnswer) {
          // Text answer
          studentAnswer = answer.textAnswer;
          // For text answers, we'll need manual grading or simple string comparison
          // For now, do a simple case-insensitive comparison
          const correctAnswer = question.correctAnswer || question.expectedAnswer || '';
          isCorrect = studentAnswer.toLowerCase().trim() === correctAnswer.toLowerCase().trim();
        }

        if (isCorrect) {
          correctAnswers++;
          score += question.points || 1;
        }

        processedAnswers.push({
          questionIndex: index,
          selectedAnswer: answer.selectedAnswer || null,
          textAnswer: answer.textAnswer || null,
          studentAnswer: studentAnswer,
          isCorrect,
          answeredAt: new Date()
        });
      }
    });
    
    const accuracy = totalAnswers > 0 ? (correctAnswers / totalAnswers) * 100 : 0;
    
    // Use atomic update to save all results at once
    const updatePath = `participants.${participantIndex}`;
    const updateQuery = {
      $set: {
        [`${updatePath}.status`]: 'completed',
        [`${updatePath}.completedAt`]: completedAt,
        [`${updatePath}.timeTaken`]: timeTaken,
        [`${updatePath}.answers`]: processedAnswers,
        [`${updatePath}.totalAnswers`]: totalAnswers,
        [`${updatePath}.correctAnswers`]: correctAnswers,
        [`${updatePath}.score`]: score,
        [`${updatePath}.accuracy`]: accuracy
      }
    };
    
    const updatedSession = await QuizSession.findByIdAndUpdate(
      req.params.sessionId,
      updateQuery,
      { 
        new: true,
        runValidators: false 
      }
    ).populate('quiz');
    
    // Calculate leaderboard
    const completedParticipants = updatedSession.participants
      .filter(p => p.status === 'completed')
      .map(p => ({
        studentId: p.student,
        studentName: p.studentName,
        score: p.score || 0,
        correctAnswers: p.correctAnswers || 0,
        timeTaken: p.timeTaken || 0,
        accuracy: p.accuracy || 0
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      });
    
    const rank = completedParticipants.findIndex(
      p => p.studentId.toString() === req.user._id.toString()
    ) + 1;

    const percentage = Math.round((correctAnswers / session.quiz.questions.length) * 100);

    // Create QuizResult record for badge assignment and tracking
    try {
      const QuizResult = require('../models/QuizResult');

      // Check if this student already has a result for this quiz (to determine attempt number)
      const existingResults = await QuizResult.find({
        student: req.user._id,
        quiz: session.quiz._id
      }).sort({ attemptNumber: -1 });

      const attemptNumber = existingResults.length > 0 ? existingResults[0].attemptNumber + 1 : 1;

      // Create new quiz result
      const quizResult = new QuizResult({
        student: req.user._id,
        quiz: session.quiz._id,
        quizTitle: session.quiz.title, // Add quiz title for display
        score: score,
        totalQuestions: session.quiz.questions.length,
        correctAnswers: correctAnswers,
        percentage: percentage,
        timeTaken: timeTaken,
        completedAt: completedAt,
        answers: processedAnswers,
        attemptNumber: attemptNumber,
        organizationId: req.user.organizationId,
        teacherId: session.quiz.createdBy,
        isCompetitiveQuiz: true, // Mark as competitive quiz
        competitiveRank: rank,
        sessionId: session._id
      });

      // Assign badge based on percentage (only for first attempts)
      quizResult.assignBadge();

      // Save the quiz result
      await quizResult.save();

      console.log(`✅ Created QuizResult for competitive quiz - Student: ${req.user.email}, Score: ${percentage}%, Badge: ${quizResult.badge || 'none'}`);

      // Include badge information in response
      res.json({
        success: true,
        results: {
          score: score,
          correctAnswers: correctAnswers,
          totalQuestions: session.quiz.questions.length,
          accuracy: accuracy,
          timeTaken: timeTaken,
          rank: rank,
          percentage: percentage,
          // Badge information
          badge: quizResult.badge,
          badgeEarned: quizResult.badgeEarned,
          badgeEarnedAt: quizResult.badgeEarnedAt,
          attemptNumber: attemptNumber,
          quizResultId: quizResult._id
        }
      });

    } catch (badgeError) {
      console.error('❌ Error creating QuizResult for competitive quiz:', badgeError);

      // Still return success but without badge info
      res.json({
        success: true,
        results: {
          score: score,
          correctAnswers: correctAnswers,
          totalQuestions: session.quiz.questions.length,
          accuracy: accuracy,
          timeTaken: timeTaken,
          rank: rank,
          percentage: percentage,
          badge: null,
          badgeEarned: false
        }
      });
    }
  } catch (error) {
    console.error('Error submitting competitive quiz:', error);
    res.status(500).json({ success: false, message: 'Error submitting quiz' });
  }
});

// Complete quiz (Student) - DEPRECATED, kept for backward compatibility
router.post('/complete/:sessionId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const session = await QuizSession.findById(req.params.sessionId).populate('quiz');
    
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Find participant index
    const participantIndex = session.participants.findIndex(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (participantIndex === -1) {
      return res.status(403).json({ success: false, message: 'You are not part of this session' });
    }
    
    const participant = session.participants[participantIndex];
    const completedAt = new Date();
    let timeTaken = 0;
    
    // Calculate time taken
    if (participant.startedAt) {
      timeTaken = Math.floor((completedAt - participant.startedAt) / 1000);
    }
    
    // Use atomic update to mark as completed
    const updatePath = `participants.${participantIndex}`;
    const updateQuery = {
      $set: {
        [`${updatePath}.status`]: 'completed',
        [`${updatePath}.completedAt`]: completedAt,
        [`${updatePath}.timeTaken`]: timeTaken
      }
    };
    
    const updatedSession = await QuizSession.findByIdAndUpdate(
      req.params.sessionId,
      updateQuery,
      { 
        new: true,
        runValidators: false 
      }
    ).populate('quiz');
    
    // Calculate leaderboard
    const completedParticipants = updatedSession.participants
      .filter(p => p.status === 'completed')
      .map(p => ({
        studentId: p.student,
        studentName: p.studentName,
        score: p.score || 0,
        correctAnswers: p.correctAnswers || 0,
        timeTaken: p.timeTaken || 0,
        accuracy: p.accuracy || 0
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      });
    
    const rank = completedParticipants.findIndex(
      p => p.studentId.toString() === req.user._id.toString()
    ) + 1;
    
    res.json({
      success: true,
      results: {
        score: participant.score || 0,
        correctAnswers: participant.correctAnswers || 0,
        totalQuestions: updatedSession.quiz.questions.length,
        accuracy: participant.accuracy || 0,
        timeTaken: timeTaken,
        rank: rank
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
    
    // Use atomic update to end the session
    const endTime = new Date();
    const updateQuery = {
      $set: {
        status: 'completed',
        endTime: endTime,
        'participants.$[elem].status': 'completed',
        'participants.$[elem].completedAt': endTime
      }
    };
    
    const updateOptions = {
      arrayFilters: [{ 'elem.status': 'in-progress' }],
      runValidators: false
    };
    
    const updatedSession = await QuizSession.findByIdAndUpdate(
      req.params.sessionId,
      updateQuery,
      { ...updateOptions, new: true }
    );
    
    // Calculate final leaderboard
    const completedParticipants = updatedSession.participants
      .filter(p => p.status === 'completed')
      .map(p => ({
        studentId: p.student,
        studentName: p.studentName,
        score: p.score || 0,
        correctAnswers: p.correctAnswers || 0,
        timeTaken: p.timeTaken || Math.floor((endTime - (p.startedAt || endTime)) / 1000),
        accuracy: p.accuracy || 0
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      });
    
    const finalLeaderboard = completedParticipants.map((p, index) => ({
      rank: index + 1,
      ...p
    }));
    
    res.json({
      success: true,
      message: 'Session ended successfully',
      finalLeaderboard: finalLeaderboard
    });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ success: false, message: 'Error ending session' });
  }
});

module.exports = router;