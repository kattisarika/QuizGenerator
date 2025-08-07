const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
require('dotenv').config();

// SaaS Multi-tenancy imports
const { 
  detectOrganization, 
  requireOrganization, 
  requireOrganizationMember, 
  requireOrganizationPermission,
  requireActiveSubscription,
  checkOrganizationLimits,
  scopeToOrganization,
  logOrganizationActivity
} = require('./middleware/tenancy');
const organizationRoutes = require('./routes/organization');

// AWS S3 configuration
const AWS = require('aws-sdk');
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1' // or your preferred region
});

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection with retry
const connectDB = async () => {
  try {
    console.log('Attempting to connect to MongoDB...');
    console.log('MONGO_URI:', process.env.MONGO_URI ? 'Set' : 'Not Set');
    console.log('MONGODB_URI:', process.env.MONGODB_URI ? 'Set' : 'Not Set');
    console.log('NODE_ENV:', process.env.NODE_ENV);
    
    // Check if environment variables are set
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('❌ No MongoDB URI found in environment variables!');
      console.error('Please set MONGO_URI or MONGODB_URI environment variable.');
      console.error('Available env vars:', Object.keys(process.env).filter(key => key.includes('MONGO')));
      return;
    }
    
    console.log('Connecting to MongoDB Atlas...');
    console.log('URI (masked):', mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));
    
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      serverApi: {
        version: '1',
        strict: true,
        deprecationErrors: true,
      }
    });
    console.log('✅ MongoDB connected successfully!');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    console.error('Error details:', err.message);
    console.error('Full error:', err);
    // Retry connection after 5 seconds
    setTimeout(connectDB, 5000);
  }
};

connectDB();

// Import models
const User = require('./models/User');
const Quiz = require('./models/Quiz');
const QuizResult = require('./models/QuizResult');
const Content = require('./models/Content');
const Organization = require('./models/Organization');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Multer configuration for file uploads (S3)
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory temporarily
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, PPT, and PPTX files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Helper function to upload file to S3
async function uploadToS3(file, folder = 'uploads') {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `${folder}/${Date.now()}-${file.originalname}`,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: 'private'
  };

  try {
    const result = await s3.upload(params).promise();
    return result.Location;
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

// Helper function to extract S3 key from URL
function extractS3Key(fileUrl) {
  try {
    // Handle different S3 URL formats
    console.log('Extracting key from URL:', fileUrl);
    
    if (fileUrl.includes('amazonaws.com')) {
      // Standard S3 URL format: https://bucket.s3.region.amazonaws.com/key
      const url = new URL(fileUrl);
      const key = url.pathname.substring(1); // Remove leading slash
      console.log('Extracted key (amazonaws.com):', key);
      return decodeURIComponent(key);
    } else if (fileUrl.includes('s3.amazonaws.com')) {
      // Alternative S3 URL format: https://s3.amazonaws.com/bucket/key
      const urlParts = fileUrl.split('/');
      const bucketIndex = urlParts.findIndex(part => part.includes('s3.amazonaws.com')) + 2; // Skip bucket name
      const key = urlParts.slice(bucketIndex).join('/');
      console.log('Extracted key (s3.amazonaws.com):', key);
      return decodeURIComponent(key);
    } else {
      // Fallback: assume last parts are the key (uploads/filename)
      const urlParts = fileUrl.split('/');
      const key = urlParts.slice(-2).join('/');
      console.log('Extracted key (fallback):', key);
      return decodeURIComponent(key);
    }
  } catch (error) {
    console.error('Error extracting S3 key:', error);
    // Fallback to original method
    const urlParts = fileUrl.split('/');
    const key = urlParts.slice(-2).join('/');
    return decodeURIComponent(key);
  }
}

// Helper function to delete file from S3
async function deleteFromS3(fileUrl) {
  try {
    const key = extractS3Key(fileUrl);
    
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME || 'skillon-test',
      Key: key
    };

    console.log('Deleting from S3:', params);
    await s3.deleteObject(params).promise();
    console.log('Successfully deleted from S3:', key);
  } catch (error) {
    console.error('Error deleting from S3:', error);
    throw error;
  }
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', './views');

// EJS layout configuration
app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to false for now to fix session issues
    maxAge: 30 * 60 * 1000 // 30 minutes (reduced from 24 hours)
  },
  name: 'takequiznow.sid',
  store: new session.MemoryStore() // Explicitly set store for production
}));

// Session timeout middleware
app.use((req, res, next) => {
  if (req.session && req.session.lastActivity) {
    const now = Date.now();
    const timeDiff = now - req.session.lastActivity;
    const timeout = 30 * 60 * 1000; // 30 minutes timeout
    
    if (timeDiff > timeout) {
      // Session expired, destroy it
      req.session.destroy((err) => {
        if (err) {
          console.error('Error destroying session:', err);
        }
      });
      
      // Redirect to login with timeout message
      if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        return res.status(401).json({ 
          error: 'Session expired', 
          message: 'Your session has expired due to inactivity. Please log in again.' 
        });
      } else {
        return res.redirect('/login?timeout=true');
      }
    }
  }
  
  // Update last activity time
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  
  next();
});

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// Passport configuration
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  // Determine callback URL based on environment
  const callbackURL = process.env.NODE_ENV === 'production' 
    ? `${process.env.BASE_URL || 'https://your-app-name.herokuapp.com'}/auth/google/callback`
    : "http://localhost:3000/auth/google/callback";
    
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: callbackURL
    },
        async function(accessToken, refreshToken, profile, cb) {
      try {
        console.log('Google OAuth authentication successful for:', profile.emails ? profile.emails[0].value : 'No email');
        
        // Check if MongoDB is connected
        if (mongoose.connection.readyState !== 1) {
          console.error('MongoDB not connected during authentication');
          return cb(new Error('Database not connected'), null);
        }
        
        // Check if user exists in database
        let user;
        try {
          user = await User.findOne({ googleId: profile.id });
        } catch (dbError) {
          console.error('Database error during user lookup:', dbError);
          return cb(new Error('Database connection failed during authentication'), null);
        }
        
        if (!user) {
          const userEmail = profile.emails ? profile.emails[0].value : '';
          
          // Check if there's a temporary user created during organization signup
          const tempUser = await User.findOne({ 
            email: userEmail, 
            googleId: { $regex: /^temp_/ } 
          });
          
          if (tempUser) {
            // Update temporary user with real Google profile data
            console.log('Found temporary user, updating with Google profile');
            tempUser.googleId = profile.id;
            tempUser.displayName = profile.displayName;
            tempUser.photos = profile.photos;
            
            try {
              await tempUser.save();
              console.log('Temporary user updated successfully');
              user = tempUser;
            } catch (saveError) {
              console.error('Error updating temporary user:', saveError);
              return cb(new Error('Failed to update user'), null);
            }
          } else {
            // New user - check if they're a super admin first
            if (userEmail === 'skillonusers@gmail.com') {
              user = new User({
                googleId: profile.id,
                displayName: profile.displayName,
                email: userEmail,
                photos: profile.photos,
                role: 'super_admin',
                isApproved: true
                // organizationId not required for super_admin
              });
            } else {
              // Regular new user - needs to go through organization signup or be invited
              console.log('New user without organization context, redirecting to signup');
              return cb(new Error('New users must be invited by a teacher or create an organization'), null);
            }
            
            try {
              await user.save();
              console.log('New user created successfully');
            } catch (saveError) {
              console.error('Error saving new user:', saveError);
              return cb(new Error('Failed to create user'), null);
            }
          }
        } else {
          console.log('Existing user found');
          // Existing user - check if they should be admin
          if (user.email === 'skillonusers@gmail.com' && user.role !== 'admin') {
            user.role = 'admin';
            user.isApproved = true;
            try {
              await user.save();
            } catch (saveError) {
              console.error('Error updating user role:', saveError);
            }
          }
        }
        
        return cb(null, user);
      } catch (error) {
        console.error('Error in Google OAuth strategy:', error);
        // Return a more specific error
        return cb(new Error('Database connection failed during authentication'), null);
      }
    }
  ));
  console.log('✅ Google OAuth configured successfully!');
} else {
  console.log('⚠️  Google OAuth credentials not configured. Please set up GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.');
  console.log('📖 See README.md for setup instructions.');
}

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    if (!user) {
      return done(null, null);
    }
    done(null, user);
  } catch (error) {
    console.error('Error during user deserialization:', error);
    done(error, null);
  }
});

// SaaS Multi-tenancy middleware setup
app.use(detectOrganization);
app.use(scopeToOrganization);

// Organization routes
app.use('/', organizationRoutes);

// Helper functions for file processing
async function extractTextFromFile(fileBuffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  
  if (ext === '.pdf') {
    const data = await pdfParse(fileBuffer);
    return data.text;
  } else if (ext === '.doc' || ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  } else {
    throw new Error('Unsupported file type');
  }
}

// Language-specific parsing patterns
function getLanguagePatterns(language) {
  const patterns = {
    English: {
      options: /[a-d]\)/gi,
      optionSplit: /\s+([a-d])[\.\)]\s*/i,
      optionLetters: ['a', 'b', 'c', 'd']
    },
    Spanish: {
      options: /[a-d]\)/gi,
      optionSplit: /\s+([a-d])[\.\)]\s*/i,
      optionLetters: ['a', 'b', 'c', 'd']
    },
    French: {
      options: /[a-d]\)/gi,
      optionSplit: /\s+([a-d])[\.\)]\s*/i,
      optionLetters: ['a', 'b', 'c', 'd']
    },
    Kannada: {
      // Kannada might use ಅ) ಆ) ಇ) ಈ) or a) b) c) d) or 1) 2) 3) 4)
      options: /([ಅಆಇಈ]|[a-d]|[1-4])\)/gi,
      optionSplit: /\s+(([ಅಆಇಈ]|[a-d]|[1-4]))[\.\)]\s*/i,
      optionLetters: ['ಅ', 'ಆ', 'ಇ', 'ಈ'], // Kannada vowels
      alternativeLetters: ['a', 'b', 'c', 'd'], // English fallback
      numberLetters: ['1', '2', '3', '4'] // Number fallback
    }
  };
  
  return patterns[language] || patterns.English;
}

function parseQuestionsFromText(text, language = 'English') {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  console.log(`🌍 Parsing questions with language: ${language}`);
  console.log(`📄 Total lines to parse: ${lines.length}`);
  console.log(`📝 First few lines:`, lines.slice(0, 3));
  
  // Define language-specific patterns
  const patterns = getLanguagePatterns(language);
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Check if line starts with a number (question) - universal pattern
    const questionMatch = trimmedLine.match(/^(\d+)[\.\)]\s*(.+)/);
    if (questionMatch) {
      const questionNumber = parseInt(questionMatch[1]);
      const fullLine = questionMatch[2].trim();
      
      // Check if this line contains all 4 options using language-specific patterns
      const optionMatches = fullLine.match(patterns.options) || [];
      console.log(`🔍 Found ${optionMatches.length} option markers in line: "${fullLine.substring(0, 100)}..."`);
      
      if (optionMatches.length >= 4) {
        // Question with all 4 options on the same line
        // Use language-specific pattern to split by option markers
        const parts = fullLine.split(patterns.optionSplit);
        
        if (parts.length >= 9) {
          // We have: [question, a, opt1, b, opt2, c, opt3, d, opt4]
          const question = {
            question: parts[0].trim(),
            type: 'multiple-choice',
            options: [
              parts[2].trim(), // Option A
              parts[4].trim(), // Option B
              parts[6].trim(), // Option C
              parts[8].trim()  // Option D
            ],
            correctAnswer: '',
            points: 1
          };
          
          console.log(`✅ Parsed question: "${question.question}"`);
          console.log(`📝 Options: [${question.options.join(', ')}]`);
          
          questions.push(question);
        } else {
          console.log(`⚠️  Could not parse options from single line, trying alternative approach`);
          
          // Try a different approach - find each option individually
          const question = {
            question: '',
            type: 'multiple-choice',
            options: [],
            correctAnswer: '',
            points: 1
          };
          
          // Find the question part (everything before the first option)
          const firstOptionMatch = fullLine.match(/\s+([a-d])[\.\)]\s*/i);
          if (firstOptionMatch) {
            const firstOptionIndex = fullLine.indexOf(firstOptionMatch[0]);
            question.question = fullLine.substring(0, firstOptionIndex).trim();
          } else {
            question.question = fullLine;
          }
          
          // Extract each option using regex - FIXED VERSION
          const optionRegex = /([a-d])[\.\)]\s*([^a-d)]+?)(?=\s+[a-d][\.\)]|$)/gi;
          let match;
          while ((match = optionRegex.exec(fullLine)) !== null) {
            question.options.push(match[2].trim());
          }
          
          // Ensure exactly 4 options
          while (question.options.length < 4) {
            question.options.push(`Option ${String.fromCharCode(65 + question.options.length)}`);
          }
          if (question.options.length > 4) {
            question.options = question.options.slice(0, 4);
          }
          
          console.log(`Parsed question (fallback): "${question.question}"`);
          console.log(`Options: [${question.options.join(', ')}]`);
          
          questions.push(question);
        }
      } else {
        // Just the question, options will come on separate lines
        const question = {
          question: fullLine,
          type: 'multiple-choice',
          options: [],
          correctAnswer: '',
          points: 1
        };
        
        // Look for options on subsequent lines
        let currentLineIndex = lines.indexOf(line);
        for (let i = currentLineIndex + 1; i < lines.length; i++) {
          const nextLine = lines[i].trim();
          
          // If we hit another question, stop
          if (nextLine.match(/^(\d+)[\.\)]\s*(.+)/)) {
            break;
          }
          
          // Check for individual option
          const optionMatch = nextLine.match(/^([a-d])[\.\)]\s*(.+)/i);
          if (optionMatch) {
            question.options.push(optionMatch[2].trim());
          } else if (question.options.length === 0) {
            // If no options yet, this might be part of the question
            question.question += ' ' + nextLine;
          } else {
            // This might be continuation of the last option
            if (question.options.length > 0) {
              question.options[question.options.length - 1] += ' ' + nextLine;
            }
          }
        }
        
        // Ensure exactly 4 options
        while (question.options.length < 4) {
          question.options.push(`Option ${String.fromCharCode(65 + question.options.length)}`);
        }
        if (question.options.length > 4) {
          question.options = question.options.slice(0, 4);
        }
        
        console.log(`Parsed question (separate): "${question.question}"`);
        console.log(`Options: [${question.options.join(', ')}]`);
        
        questions.push(question);
      }
    }
  }
  
  // If no questions found with strict parsing, try flexible parsing
  if (questions.length === 0) {
    console.log(`⚡ No questions found with strict parsing, trying flexible approach for ${language}`);
    return parseQuestionsFlexible(text, language);
  }
  
  console.log(`✅ Total questions found: ${questions.length}`);
  return questions;
}

// Flexible parsing for languages that might not follow standard patterns
function parseQuestionsFlexible(text, language) {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  console.log(`🔄 Flexible parsing: Processing ${lines.length} lines for ${language}`);
  
  let currentQuestion = null;
  let optionCount = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    console.log(`🔍 Line ${i}: "${line}"`);
    
    // Look for numbered lines (potential questions)
    const numberMatch = line.match(/^(\d+)[\.\)]\s*(.*)$/);
    if (numberMatch) {
      console.log(`📝 Found question number ${numberMatch[1]}: "${numberMatch[2]}"`);
      
      // Save previous question if it has options
      if (currentQuestion && currentQuestion.options.length >= 2) {
        // Ensure we have 4 options, pad with empty if needed
        while (currentQuestion.options.length < 4) {
          currentQuestion.options.push(`Option ${currentQuestion.options.length + 1}`);
        }
        questions.push(currentQuestion);
        console.log(`✅ Added question: "${currentQuestion.question.substring(0, 50)}..." with ${currentQuestion.options.length} options`);
      }
      
      // Start new question
      let questionText = numberMatch[2].trim();
      
      // If no text after the number, check the next line
      if (!questionText && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // Check if next line is not an option marker
        if (!nextLine.match(/^([ಅಆಇಈ]|[a-d]|[1-4])[\.\)]/i)) {
          questionText = nextLine;
          i++; // Skip the next line since we used it
          console.log(`📝 Question text from next line: "${questionText}"`);
        }
      }
      
      currentQuestion = {
        question: questionText || `Question ${numberMatch[1]}`,
        type: 'multiple-choice',
        options: [],
        correctAnswer: '',
        points: 1
      };
      optionCount = 0;
      continue;
    }
    
    // Look for option patterns if we have a current question
    if (currentQuestion && optionCount < 4) {
      let optionMatch = null;
      
      // Try different option patterns based on language
      if (language === 'Kannada') {
        // Try Kannada vowels, English letters, or numbers
        optionMatch = line.match(/^([ಅಆಇಈ]|[a-d]|[1-4])[\.\)]\s*(.+)/i);
      } else {
        // Default to English letters or numbers
        optionMatch = line.match(/^([a-d]|[1-4])[\.\)]\s*(.+)/i);
      }
      
      if (optionMatch) {
        const optionText = optionMatch[2].trim();
        currentQuestion.options.push(optionText);
        optionCount++;
        console.log(`🎯 Found option ${optionCount} (${optionMatch[1]}): "${optionText}"`);
      } else if (currentQuestion && line.length > 3 && !line.match(/^\d+/) && !line.includes('_')) {
        // If it's a reasonable line without numbering and not a form field, might be an option without markers
        // Exclude lines with underscores (likely form fields)
        currentQuestion.options.push(line);
        optionCount++;
        console.log(`🎯 Found unmarked option ${optionCount}: "${line}"`);
      }
    }
  }
  
  // Save the last question
  if (currentQuestion && currentQuestion.options.length >= 2) {
    while (currentQuestion.options.length < 4) {
      currentQuestion.options.push(`Option ${currentQuestion.options.length + 1}`);
    }
    questions.push(currentQuestion);
    console.log(`✅ Added final question: "${currentQuestion.question.substring(0, 50)}..." with ${currentQuestion.options.length} options`);
  }
  
  console.log(`🎉 Flexible parsing completed: ${questions.length} questions found`);
  return questions;
}

// Helper: Split combined options from a single string using option markers
function splitOptionsFromText(optionText) {
  const parts = optionText.split(/(?=[a-dA-D]\))/); // Split before a), b), etc.
  return parts.map(opt => opt.replace(/^[a-dA-D]\)\s*/, '').trim()).filter(opt => opt.length > 0);
}

// Helper function to ensure exactly 4 options
function ensureFourOptions(question) {
  console.log(`ensureFourOptions called for question with ${question.options.length} options:`, question.options);
  
  // If no options found, create default options
  if (question.options.length === 0) {
    question.options = ['Option A', 'Option B', 'Option C', 'Option D'];
    console.log('No options found, created default options');
    return;
  }
  
  // If options contain one long string, try to split
  if (
    question.options.length === 1 &&
    /a\)|b\)|c\)|d\)/i.test(question.options[0])
  ) {
    question.options = splitOptionsFromText(question.options[0]);
    console.log('Split combined option string into:', question.options);
  }
  
  // Loop through options to catch any that are still combined
  for (let i = 0; i < question.options.length; i++) {
    const option = question.options[i];
    if (/([a-dA-D])\)/g.test(option) && option.match(/([a-dA-D])\)/g).length > 1) {
      const split = splitOptionsFromText(option);
      question.options.splice(i, 1, ...split);
      console.log(`Split embedded options in option ${i}:`, split);
    }
  }
  
  // Clean up options
  question.options = question.options.filter(option => option.trim().length > 0);
  
  // Always force exactly 4 options
  while (question.options.length < 4) {
    const newOption = `Option ${String.fromCharCode(65 + question.options.length)}`;
    question.options.push(newOption);
    console.log(`Added option: ${newOption}`);
  }
  
  if (question.options.length > 4) {
    question.options = question.options.slice(0, 4);
    console.log('Trimmed options to 4:', question.options);
  }
  
  console.log(`Final options count: ${question.options.length}, options:`, question.options);
}

function parseAnswersFromText(text) {
  const answers = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  console.log('Parsing answer text:', text.substring(0, 200) + '...');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    console.log('Processing answer line:', trimmedLine);
    
    // Handle quoted format like "1. B", "2. A", etc.
    const quotedMatches = trimmedLine.match(/"(\d+)\.\s*([a-d])"/gi);
    if (quotedMatches) {
      quotedMatches.forEach(match => {
        const answerMatch = match.match(/"(\d+)\.\s*([a-d])"/i);
        if (answerMatch) {
          const questionNumber = parseInt(answerMatch[1]);
          const answer = answerMatch[2].toUpperCase();
          console.log(`Found quoted answer: Question ${questionNumber} = ${answer}`);
          answers.push({
            questionNumber: questionNumber,
            answer: answer
          });
        }
      });
      continue;
    }
    
    // Try multiple formats for answer parsing
    let answerMatch = trimmedLine.match(/^(\d+)[\.\)]\s*([a-d])/i);
    if (!answerMatch) {
      answerMatch = trimmedLine.match(/^(\d+)\s*[\.\)]?\s*([a-d])/i);
    }
    if (!answerMatch) {
      answerMatch = trimmedLine.match(/^(\d+)\s*:\s*([a-d])/i);
    }
    if (!answerMatch) {
      answerMatch = trimmedLine.match(/^(\d+)\s*-\s*([a-d])/i);
    }
    if (!answerMatch) {
      answerMatch = trimmedLine.match(/^(\d+)\s+([a-d])/i);
    }
    if (!answerMatch) {
      // Handle comma-separated format
      answerMatch = trimmedLine.match(/(\d+)\.\s*([a-d])/gi);
      if (answerMatch) {
        answerMatch.forEach(match => {
          const singleMatch = match.match(/(\d+)\.\s*([a-d])/i);
          if (singleMatch) {
            const questionNumber = parseInt(singleMatch[1]);
            const answer = singleMatch[2].toUpperCase();
            console.log(`Found comma-separated answer: Question ${questionNumber} = ${answer}`);
            answers.push({
              questionNumber: questionNumber,
              answer: answer
            });
          }
        });
      }
    }
    
    if (answerMatch && !Array.isArray(answerMatch)) {
      const questionNumber = parseInt(answerMatch[1]);
      const answer = answerMatch[2].toUpperCase();
      console.log(`Found answer: Question ${questionNumber} = ${answer}`);
      answers.push({
        questionNumber: questionNumber,
        answer: answer
      });
    }
  }
  
  console.log('Total answers found:', answers.length);
  return answers;
}

function mergeQuestionsWithAnswers(questions, answers) {
  console.log('Merging questions with answers:', { questionsCount: questions.length, answersCount: answers.length });
  
  return questions.map((question, index) => {
    const answer = answers.find(a => a.questionNumber === index + 1);
    console.log(`Question ${index + 1}:`, { 
      questionText: question.question.substring(0, 50) + '...',
      optionsCount: question.options.length,
      foundAnswer: answer ? answer.answer : 'none'
    });
    
    if (answer && question.options.length > 0) {
      const answerIndex = answer.answer.charCodeAt(0) - 65; // Convert A=0, B=1, etc.
      console.log(`Answer index for ${answer.answer}: ${answerIndex}`);
      
      if (answerIndex >= 0 && answerIndex < question.options.length) {
        question.correctAnswer = question.options[answerIndex];
        console.log(`Set correct answer: ${question.correctAnswer}`);
      } else {
        console.log(`Invalid answer index: ${answerIndex} for options length: ${question.options.length}`);
      }
    }
    
    // If no answer key provided, set a default or leave empty
    if (!question.correctAnswer) {
      question.correctAnswer = question.options.length > 0 ? question.options[0] : '';
      console.log(`No answer found, using default: ${question.correctAnswer}`);
    }
    
    return question;
  });
}

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
};

// Middleware to check user roles
const requireRole = (roles) => {
  return (req, res, next) => {
    console.log('requireRole middleware - Required roles:', roles);
    
    // Add null check for req.user
    if (!req.user) {
      console.error('User not found in requireRole middleware');
      return res.redirect('/login?error=Authentication failed');
    }
    
    console.log('requireRole middleware - User role:', req.user.role, 'User ID:', req.user._id);
    
    if (roles.includes(req.user.role)) {
      console.log('Role check passed, proceeding to next middleware');
      return next();
    }
    
    console.error('Role check failed - User role:', req.user.role, 'Required roles:', roles);
    res.status(403).render('error', { error: 'Access denied. You do not have permission to view this page.' });
  };
};

// Middleware to check if teacher is approved
const requireApprovedTeacher = (req, res, next) => {
  console.log('requireApprovedTeacher middleware - User role:', req.user.role, 'Approved:', req.user.isApproved);
  
  if (req.user.role === 'teacher' && !req.user.isApproved) {
    console.log('Teacher not approved, showing pending approval page');
    return res.render('pending-approval', { user: req.user });
  }
  
  console.log('Teacher approval check passed, proceeding to route handler');
  next();
};

// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

// SaaS Teacher Signup Route
app.get('/teacher-signup', (req, res) => {
  res.render('teacher-signup', { title: 'Create Your Teaching Organization' });
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  const error = req.query.error || null;
  const timeout = req.query.timeout === 'true';
  res.render('login', { error, timeout });
});

app.get('/dashboard', isAuthenticated, (req, res) => {
  // Add null check for req.user
  if (!req.user) {
    console.error('User not found in dashboard route');
    return res.redirect('/login?error=Authentication failed');
  }
  
  // If user doesn't have a role, redirect to role selection
  if (!req.user.role) {
    return res.redirect('/select-role');
  }
  
  // Auto-redirect based on role
  if (req.user.role === 'student') {
    return res.redirect('/student/dashboard');
  } else if (req.user.role === 'teacher') {
    if (req.user.isApproved) {
      return res.redirect('/teacher/dashboard');
    } else {
      return res.render('pending-approval', { user: req.user });
    }
  } else if (req.user.role === 'admin') {
    return res.redirect('/admin/dashboard');
  }
  
  // Fallback to dashboard template
  res.render('dashboard', { user: req.user });
});

// API endpoint to get content file URL for external viewers
app.get('/api/content-url/:contentId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }
    
    // Return the file URL for external viewers
    res.json({ 
      success: true, 
      fileUrl: content.fileUrl,
      fileName: content.fileName,
      fileType: content.fileType
    });
  } catch (error) {
    console.error('Error getting content URL:', error);
    res.status(500).json({ success: false, message: 'Error getting content URL' });
  }
});

// API endpoint to get a signed URL for external viewers
app.get('/api/signed-url/:contentId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }
    
    // Generate a signed URL for external viewers (valid for 1 hour)
    try {
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'us-east-1'
      });
      
      const key = extractS3Key(content.fileUrl);
      const params = {
        Bucket: process.env.AWS_BUCKET_NAME || 'skillon-test',
        Key: key,
        Expires: 3600 // 1 hour
      };
      
      const signedUrl = s3.getSignedUrl('getObject', params);
      console.log('Generated signed URL for external viewers:', signedUrl);
      
      res.json({ 
        success: true, 
        signedUrl: signedUrl,
        originalUrl: content.fileUrl,
        fileName: content.fileName,
        fileType: content.fileType
      });
    } catch (s3Error) {
      console.error('Error generating signed URL:', s3Error);
      // Fallback to original URL
      res.json({ 
        success: true, 
        signedUrl: content.fileUrl,
        originalUrl: content.fileUrl,
        fileName: content.fileName,
        fileType: content.fileType,
        fallback: true
      });
    }
  } catch (error) {
    console.error('Error getting signed URL:', error);
    res.status(500).json({ success: false, message: 'Error getting signed URL' });
  }
});

// Role-specific dashboards
app.get('/teacher/dashboard', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const teacherQuizzes = await Quiz.find({ createdBy: req.user._id });
    res.render('teacher-dashboard', { 
      user: req.user, 
      quizzes: teacherQuizzes
    });
  } catch (error) {
    console.error('Error fetching teacher quizzes:', error);
    res.render('teacher-dashboard', { 
      user: req.user, 
      quizzes: []
    });
  }
});





// Route for student study material page
app.get('/student/study-material', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    // Get approved content filtered by student's grade level
    let query = { isApproved: true };
    let messageForStudent = null;
    
    // Filter by student's grade level if it exists
    if (req.user.gradeLevel) {
      query.gradeLevel = req.user.gradeLevel;
      console.log(`🎓 Filtering content for student ${req.user.displayName} (${req.user.gradeLevel})`);
      console.log(`📋 Query: ${JSON.stringify(query)}`);
    } else {
      console.log(`⚠️  Student ${req.user.displayName} has no grade level set - showing all content`);
      messageForStudent = "Your grade level is not set. Please ask your teacher to assign you to the correct grade, or update your profile.";
    }
    
    const studyMaterial = await Content.find(query)
      .populate('createdBy', 'displayName')
      .sort({ createdAt: -1 });
    
    console.log(`📚 Found ${studyMaterial.length} study materials for grade ${req.user.gradeLevel || 'any'}`);
    
    // Get all content for debugging
    const allContent = await Content.find({ isApproved: true }).select('title gradeLevel createdByName');
    console.log(`📊 All available content by grade:`);
    const contentByGrade = {};
    allContent.forEach(content => {
      if (!contentByGrade[content.gradeLevel]) {
        contentByGrade[content.gradeLevel] = [];
      }
      contentByGrade[content.gradeLevel].push(content.title);
    });
    console.log(contentByGrade);
    
    res.render('student-study-material', {
      user: req.user,
      studyMaterial,
      gradeMessage: messageForStudent
    });
  } catch (error) {
    console.error('Error fetching study material:', error);
    res.render('student-study-material', {
      user: req.user,
      studyMaterial: []
    });
  }
});

// Route for viewing content in browser (increment view count)
app.get('/student/view-content/:contentId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).send('Content not found');
    }
    
    // Increment view count
    content.views += 1;
    await content.save();
    
    // Check if it's a PowerPoint file
    const isPowerPoint = content.fileType.includes('powerpoint') || 
                        content.fileName.toLowerCase().includes('.ppt') ||
                        content.fileName.toLowerCase().includes('.pptx');
    
    // Check if this is a request for embedded viewing (from modal)
    const isEmbedded = req.query.embed === 'true';
    
    if (isPowerPoint && !isEmbedded) {
      // For PowerPoint files accessed directly, show the full viewer page
      return res.render('powerpoint-viewer', {
        user: req.user,
        content: content
      });
    } else if (isPowerPoint && isEmbedded) {
      // For embedded PowerPoint viewing, create a minimal embedded viewer
      return res.render('embedded-office-viewer', {
        user: req.user,
        content: content
      });
    }
    
    // For DOC/DOCX files, also use the viewer
    const isWordDoc = content.fileType.includes('word') || 
                      content.fileName.toLowerCase().includes('.doc') ||
                      content.fileName.toLowerCase().includes('.docx');
    
    if (isWordDoc) {
      return res.render('powerpoint-viewer', {
        user: req.user,
        content: content
      });
    }
    
    // For other files (PDF, DOC, etc.), fetch from S3 and serve
    try {
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'us-east-1'
      });
      
      // Extract the key from the URL using improved function
      const key = extractS3Key(content.fileUrl);
      
      const params = {
        Bucket: process.env.AWS_BUCKET_NAME || 'skillon-test',
        Key: key
      };
      
      const fileObject = await s3.getObject(params).promise();
      
      // Set appropriate headers for viewing (not downloading)
      res.setHeader('Content-Type', content.fileType);
      res.setHeader('Content-Disposition', 'inline'); // 'inline' for viewing, not 'attachment'
      res.setHeader('Content-Length', fileObject.ContentLength);
      
      // Send the file for viewing
      res.send(fileObject.Body);
      
    } catch (s3Error) {
      console.error('S3 error in view-content:', s3Error);
      console.error('File URL:', content.fileUrl);
      console.error('Content ID:', contentId);
      console.error('Extracted key:', extractS3Key(content.fileUrl));
      // Fallback to redirect if S3 access fails
      res.redirect(content.fileUrl);
    }
  } catch (error) {
    console.error('Error viewing content:', error);
    res.status(500).send('Error viewing content');
  }
});

// Route for downloading content (increment download count)
app.get('/student/download-content/:contentId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).send('Content not found');
    }
    
    // Increment download count
    content.downloads += 1;
    await content.save();
    
    // Check if it's a PowerPoint file and user wants to view in browser
    const isPowerPoint = content.fileType.includes('powerpoint') || 
                        content.fileName.toLowerCase().includes('.ppt') ||
                        content.fileName.toLowerCase().includes('.pptx');
    
    // Instead of redirecting, fetch the file and serve it
    try {
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'us-east-1'
      });
      
      // Extract the key from the URL using improved function
      const key = extractS3Key(content.fileUrl);
      
      const params = {
        Bucket: process.env.AWS_BUCKET_NAME || 'skillon-test',
        Key: key
      };
      
      const fileObject = await s3.getObject(params).promise();
      
      // For PowerPoint files, try to serve with inline disposition for browser viewing
      if (isPowerPoint) {
        res.setHeader('Content-Type', content.fileType);
        res.setHeader('Content-Disposition', 'inline'); // Try inline for browser viewing
        res.setHeader('Content-Length', fileObject.ContentLength);
      } else {
        // For other files, serve as download
        res.setHeader('Content-Type', content.fileType);
        res.setHeader('Content-Disposition', `attachment; filename="${content.fileName}"`);
        res.setHeader('Content-Length', fileObject.ContentLength);
      }
      
      // Send the file
      res.send(fileObject.Body);
      
    } catch (s3Error) {
      console.error('S3 error in download-content:', s3Error);
      console.error('File URL:', content.fileUrl);
      console.error('Content ID:', contentId);
      console.error('Extracted key:', extractS3Key(content.fileUrl));
      // Fallback to redirect if S3 access fails
      res.redirect(content.fileUrl);
    }
  } catch (error) {
    console.error('Error downloading content:', error);
    res.status(500).send('Error downloading content');
  }
});

app.get('/student/dashboard', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const availableQuizzes = await Quiz.find({ isApproved: true });
    
    // Fetch student's quiz results
    const quizResults = await QuizResult.find({ student: req.user._id });
    const completedCount = quizResults.length;
    
    // Calculate average score
    let averageScore = 0;
    if (completedCount > 0) {
      const totalScore = quizResults.reduce((sum, result) => sum + result.percentage, 0);
      averageScore = Math.round(totalScore / completedCount);
    }
    
    res.render('student-dashboard', { 
      user: req.user, 
      quizzes: availableQuizzes,
      completedCount,
      averageScore
    });
  } catch (error) {
    console.error('Error fetching student dashboard data:', error);
    res.render('student-dashboard', { 
      user: req.user, 
      quizzes: [],
      completedCount: 0,
      averageScore: 0
    });
  }
});

app.get('/admin/dashboard', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const pendingTeachers = await User.find({ role: 'teacher', isApproved: false });
    const pendingQuizzes = await Quiz.find({ isApproved: false });
    res.render('admin-dashboard', { user: req.user, pendingTeachers, pendingQuizzes });
  } catch (error) {
    console.error('Error fetching admin data:', error);
    res.render('admin-dashboard', { user: req.user, pendingTeachers: [], pendingQuizzes: [] });
  }
});

// Role selection page
app.get('/select-role', isAuthenticated, (req, res) => {
  res.render('select-role', { user: req.user });
});

app.post('/select-role', isAuthenticated, async (req, res) => {
  try {
    const { role } = req.body;

    if (['student', 'teacher'].includes(role)) {
      req.user.role = role;
      
      if (role === 'teacher') {
        req.user.isApproved = false; // Teachers need approval
      } else {
        req.user.isApproved = true; // Students are auto-approved
      }

      await req.user.save();
      res.redirect('/dashboard');
    } else {
      res.redirect('/select-role');
    }
  } catch (error) {
    console.error('Error updating user role:', error);
    res.redirect('/select-role');
  }
});

// Quiz management routes
app.get('/create-quiz', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, (req, res) => {
  res.render('create-quiz', { user: req.user });
});

app.post('/create-quiz', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, upload.fields([
  { name: 'questionPaper', maxCount: 1 },
  { name: 'answerPaper', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, description, gradeLevel, subjects, language } = req.body;
    let extractedQuestions = [];
    let questionFileUrl = null;
    let answerFileUrl = null;

    // Debug: Log all form data
    console.log('Received form data:', req.body);
    console.log('Files received:', req.files);
    
    // Validate grade level and subjects
    if (!gradeLevel) {
      console.log('Validation error: Grade level is missing');
      return res.status(400).send('Grade level is required');
    }
    
    console.log('Grade level received:', gradeLevel);
    console.log('Subject received:', subjects);
    console.log('Subject type:', typeof subjects);
    
    if (!subjects) {
      console.log('Validation error: No subject selected');
      console.log('Subject value:', subjects);
      return res.status(400).send('Please select a subject');
    }

    // Validate language
    const validLanguages = ['English', 'Spanish', 'French', 'Kannada'];
    if (!language || !validLanguages.includes(language)) {
      console.log('Validation error: Invalid language selected');
      console.log('Language value:', language);
      return res.status(400).send('Please select a valid language');
    }

    console.log('Form validation passed:', { gradeLevel, subjects, language });

    console.log('Creating quiz:', { title, description, gradeLevel, subjects });

    console.log('Creating quiz:', { title, description });

    // Process question paper
    if (req.files.questionPaper && req.files.questionPaper[0]) {
      const questionFile = req.files.questionPaper[0];
      console.log('Processing question file:', questionFile.originalname);
      console.log('File size:', questionFile.size, 'bytes');
      console.log('File mimetype:', questionFile.mimetype);
      
      try {
        // Upload to S3 first
        questionFileUrl = await uploadToS3(questionFile, 'question-papers');
        console.log('Question paper uploaded to S3:', questionFileUrl);
        
        const questionText = await extractTextFromFile(questionFile.buffer, questionFile.originalname);
        console.log('Extracted text length:', questionText.length);
        
        if (!questionText || questionText.trim().length === 0) {
          console.log('Error: No text extracted from question file');
          return res.status(400).send('Could not extract text from the uploaded question paper. Please ensure the file is not corrupted and contains readable text.');
        }
        
        extractedQuestions = parseQuestionsFromText(questionText, language);
        console.log('Parsed questions count:', extractedQuestions.length);
        
        if (extractedQuestions.length === 0) {
          console.log('Error: No questions parsed from text');
          return res.status(400).send('No questions could be parsed from the uploaded file. Please ensure the question paper follows the required format with numbered questions and multiple choice options.');
        }
      } catch (error) {
        console.error('Error processing question file:', error);
        return res.status(400).send('Error processing the question paper. Please ensure the file is in a supported format (PDF, DOC, DOCX) and contains readable text.');
      }
      
      // Debug: Log the first question's options
      if (extractedQuestions.length > 0) {
        console.log('First question options count:', extractedQuestions[0].options.length);
        console.log('First question options:', extractedQuestions[0].options);
        
              // Force ensure 4 options for all questions
      extractedQuestions.forEach((question, index) => {
        console.log(`Question ${index + 1} before fix:`, question.options.length, 'options');
        console.log(`Question ${index + 1} original options:`, question.options);
        
        // AGGRESSIVE FIX: Force exactly 4 options
        if (question.options.length < 4) {
          while (question.options.length < 4) {
            const newOption = `Option ${String.fromCharCode(65 + question.options.length)}`;
            question.options.push(newOption);
            console.log(`Question ${index + 1} added option: ${newOption}`);
          }
        } else if (question.options.length > 4) {
          question.options = question.options.slice(0, 4);
          console.log(`Question ${index + 1} trimmed to 4 options`);
        }
        
        ensureFourOptions(question);
        console.log(`Question ${index + 1} after fix:`, question.options.length, 'options');
        console.log(`Question ${index + 1} final options:`, question.options);
      });
      }
    } else {
      console.log('No question paper uploaded');
      return res.status(400).send('Question paper is required');
    }

    // Process answer paper if provided
    if (req.files.answerPaper && req.files.answerPaper[0]) {
      const answerFile = req.files.answerPaper[0];
      console.log('Processing answer file:', answerFile.originalname);
      
      // Upload to S3 first
      answerFileUrl = await uploadToS3(answerFile, 'answer-papers');
      console.log('Answer paper uploaded to S3:', answerFileUrl);
      
      const answerText = await extractTextFromFile(answerFile.buffer, answerFile.originalname);
      const answers = parseAnswersFromText(answerText);
      console.log('Parsed answers count:', answers.length);
      
      // Merge answers with questions
      extractedQuestions = mergeQuestionsWithAnswers(extractedQuestions, answers);
    }

    // Ensure all questions have valid structure
    extractedQuestions = extractedQuestions.map((q, index) => ({
      question: q.question || `Question ${index + 1}`,
      type: 'multiple-choice',
      options: q.options && q.options.length > 0 ? q.options : ['Option A', 'Option B', 'Option C', 'Option D'],
      correctAnswer: q.correctAnswer || (q.options && q.options.length > 0 ? q.options[0] : ''),
      points: 1
    }));

    console.log('Final questions to save:', extractedQuestions.length);

    const quiz = new Quiz({
      title,
      description,
      gradeLevel,
      subjects: [subjects], // Convert single subject to array for database
      language: language, // Include selected language
      questions: extractedQuestions,
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      isApproved: false,
      questionPaperUrl: questionFileUrl, // Store S3 URL
      answerPaperUrl: answerFileUrl || null // Store S3 URL if provided
    });

    await quiz.save();
    console.log('Quiz saved successfully with ID:', quiz._id);
    console.log('Question paper stored at:', questionFileUrl);
    if (answerFileUrl) {
      console.log('Answer paper stored at:', answerFileUrl);
    }

    res.redirect('/teacher/dashboard');
  } catch (error) {
    console.error('Error creating quiz:', error);
    res.status(500).send(`Error creating quiz: ${error.message}`);
  }
});



// Route to check current user status
app.get('/check-user', isAuthenticated, async (req, res) => {
  try {
    res.send(`
      <h2>Current User Status</h2>
      <p><strong>Email:</strong> ${req.user.email}</p>
      <p><strong>Name:</strong> ${req.user.displayName}</p>
      <p><strong>Role:</strong> ${req.user.role}</p>
      <p><strong>Approved:</strong> ${req.user.isApproved ? 'Yes' : 'No'}</p>
      <p><strong>User ID:</strong> ${req.user._id}</p>
      <br>
      <a href="/dashboard">Go to Dashboard</a>
      <a href="/make-admin">Make Admin</a>
    `);
  } catch (error) {
    res.status(500).send('Error checking user status');
  }
});

// Test route for question parsing
app.get('/test-parsing', (req, res) => {
  const sampleText = `1. What is the capital of France?
A. London
B. Paris
C. Berlin
D. Madrid

2. Which planet is known as the Red Planet?
A. Venus
B. Mars
C. Jupiter
D. Saturn`;

  const questions = parseQuestionsFromText(sampleText, 'English');
  res.json({
    originalText: sampleText,
    parsedQuestions: questions
  });
});

// Test route for answer parsing
app.get('/test-answer-parsing', (req, res) => {
  const sampleAnswerText = `1. B
2. B
3. C
4. A
5. D`;

  const answers = parseAnswersFromText(sampleAnswerText);
  res.json({
    originalText: sampleAnswerText,
    parsedAnswers: answers
  });
});

// Test route for actual answer format
app.get('/test-actual-answer', (req, res) => {
  const actualAnswerText = `Answer Key
"1. B", "2. A","3. b",
"4. A",
"5. d",
"6. b",
"7. b",
"8. c",
"9. b",
"10. b"`;

  const answers = parseAnswersFromText(actualAnswerText);
  res.json({
    originalText: actualAnswerText,
    parsedAnswers: answers
  });
});

// Route to view student results for a specific quiz
app.get('/quiz-results/:quizId', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const { quizId } = req.params;
    
    // Verify the quiz belongs to this teacher
    const quiz = await Quiz.findOne({ _id: quizId, createdBy: req.user._id });
    if (!quiz) {
      return res.status(404).send('Quiz not found or access denied');
    }
    
    // Fetch all results for this quiz
    const results = await QuizResult.find({ quiz: quizId })
      .populate('student', 'displayName email')
      .sort({ completedAt: -1 });
    
    res.render('quiz-results', { 
      user: req.user, 
      quiz, 
      results 
    });
  } catch (error) {
    console.error('Error fetching quiz results:', error);
    res.status(500).send('Error fetching quiz results');
  }
});

// Route for teacher's post content page
app.get('/teacher/post-content', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    // Get all content posted by this teacher
    const teacherContent = await Content.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
    
    res.render('teacher-post-content', { 
      user: req.user, 
      content: teacherContent
    });
  } catch (error) {
    console.error('Error fetching teacher content:', error);
    res.render('teacher-post-content', { 
      user: req.user, 
      content: []
    });
  }
});

// Route for posting new content
app.post('/teacher/post-content', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, upload.single('contentFile'), async (req, res) => {
  try {
    const { title, description, category, gradeLevel } = req.body;
    
    if (!req.file) {
      return res.status(400).send('Please upload a file');
    }
    
    if (!gradeLevel) {
      return res.status(400).send('Please select a grade level');
    }
    
    // Validate grade level
    const validGrades = ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', 
                        '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'];
    
    if (!validGrades.includes(gradeLevel)) {
      return res.status(400).send('Invalid grade level selected');
    }
    
    // Upload file to S3
    const fileUrl = await uploadToS3(req.file, 'content');
    
    // Create new content
    const content = new Content({
      title,
      description,
      category,
      gradeLevel,
      fileUrl,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      isApproved: true  // Auto-approve content from approved teachers
    });
    
    await content.save();
    
    console.log(`✅ Content created successfully:`, {
      title: content.title,
      gradeLevel: content.gradeLevel,
      isApproved: content.isApproved,
      createdBy: content.createdByName,
      contentId: content._id
    });
    
    res.redirect('/teacher/post-content');
  } catch (error) {
    console.error('Error posting content:', error);
    res.status(500).send('Error posting content');
  }
});

// Route to approve all pending content (for existing content)
app.post('/admin/approve-all-content', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const result = await Content.updateMany(
      { isApproved: false },
      { isApproved: true }
    );
    
    res.json({ 
      success: true, 
      message: `Approved ${result.modifiedCount} content items`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('Error approving all content:', error);
    res.status(500).json({ success: false, message: 'Error approving content' });
  }
});

// ===== TEACHER ASSIGN STUDENTS ROUTES =====

// Test route to verify routing works
app.get('/teacher/test-assign', isAuthenticated, requireRole(['teacher']), (req, res) => {
  res.send(`<h1>Test Route Works!</h1><p>User: ${req.user.displayName}</p><p>Role: ${req.user.role}</p>`);
});

// Route for teacher assign students page
app.get('/teacher/assign-students', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    console.log('Accessing /teacher/assign-students route');
    console.log('User:', req.user.displayName, 'Role:', req.user.role, 'Approved:', req.user.isApproved);
    
    // Get all students
    const students = await User.find({ role: 'student' }).sort({ displayName: 1 });
    console.log('Found', students.length, 'students');
    
    // Count statistics
    const assignedToMe = await User.countDocuments({ 
      role: 'student', 
      assignedTeacher: req.user._id 
    });
    
    const unassigned = await User.countDocuments({ 
      role: 'student', 
      assignedTeacher: null 
    });
    
    console.log('Statistics:', { assignedToMe, unassigned });
    
    res.render('teacher-assign-students', { 
      user: req.user, 
      students: students,
      assignedToMe: assignedToMe,
      unassigned: unassigned
    });
  } catch (error) {
    console.error('Error in assign-students route:', error);
    console.error('Error details:', error.message);
    console.error('Stack trace:', error.stack);
    
    // Fallback response for debugging
    res.status(500).send(`
      <h1>Error in Assign Students Route</h1>
      <p><strong>Error:</strong> ${error.message}</p>
      <p><strong>User:</strong> ${req.user.displayName}</p>
      <p><strong>User ID:</strong> ${req.user._id}</p>
      <p><strong>Route reached successfully</strong></p>
      <a href="/teacher/dashboard">Back to Dashboard</a>
    `);
  }
});

// Route to assign students to teacher
app.post('/teacher/assign-students', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const { assignments } = req.body;
    
    if (!assignments || !Array.isArray(assignments)) {
      return res.status(400).json({ success: false, message: 'Invalid assignments data' });
    }
    
    // Validate grade levels
    const validGrades = ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', 
                        '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'];
    
    for (const assignment of assignments) {
      if (!validGrades.includes(assignment.gradeLevel)) {
        return res.status(400).json({ 
          success: false, 
          message: `Invalid grade level: ${assignment.gradeLevel}` 
        });
      }
    }
    
    // Update students
    const updatePromises = assignments.map(assignment => 
      User.findByIdAndUpdate(
        assignment.studentId,
        { 
          assignedTeacher: req.user._id,
          gradeLevel: assignment.gradeLevel
        },
        { new: true }
      )
    );
    
    await Promise.all(updatePromises);
    
    console.log(`Teacher ${req.user.displayName} assigned ${assignments.length} students`);
    
    res.json({ success: true, message: `Successfully assigned ${assignments.length} students` });
  } catch (error) {
    console.error('Error assigning students:', error);
    res.status(500).json({ success: false, message: 'Error assigning students' });
  }
});

// Route to unassign students from teacher
app.post('/teacher/unassign-students', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const { studentIds } = req.body;
    
    if (!studentIds || !Array.isArray(studentIds)) {
      return res.status(400).json({ success: false, message: 'Invalid student IDs' });
    }
    
    // Only allow unassigning students that are currently assigned to this teacher
    const result = await User.updateMany(
      { 
        _id: { $in: studentIds },
        assignedTeacher: req.user._id 
      },
      { 
        assignedTeacher: null
      }
    );
    
    console.log(`Teacher ${req.user.displayName} unassigned ${result.modifiedCount} students`);
    
    res.json({ 
      success: true, 
      message: `Successfully unassigned ${result.modifiedCount} students` 
    });
  } catch (error) {
    console.error('Error unassigning students:', error);
    res.status(500).json({ success: false, message: 'Error unassigning students' });
  }
});

// ===== END TEACHER ASSIGN STUDENTS ROUTES =====

// Route to auto-approve all teacher content (for fixing existing unapproved content)
app.post('/admin/approve-all-teacher-content', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    // Find all unapproved content created by approved teachers
    const approvedTeachers = await User.find({ role: 'teacher', isApproved: true }).select('_id');
    const teacherIds = approvedTeachers.map(teacher => teacher._id);
    
    const result = await Content.updateMany(
      { 
        isApproved: false,
        createdBy: { $in: teacherIds }
      },
      { 
        isApproved: true 
      }
    );
    
    console.log(`Auto-approved ${result.modifiedCount} content items from approved teachers`);
    
    res.json({ 
      success: true, 
      message: `Approved ${result.modifiedCount} content items from teachers`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('Error auto-approving teacher content:', error);
    res.status(500).json({ success: false, message: 'Error auto-approving content' });
  }
});

// Route for viewing content distribution by grade (for debugging)
app.get('/admin/content-by-grade', isAuthenticated, requireRole(['admin', 'teacher']), async (req, res) => {
  try {
    const allContent = await Content.find({})  // Show ALL content, approved and unapproved
      .populate('createdBy', 'displayName')
      .sort({ gradeLevel: 1, createdAt: -1 });
    
    const approvedContent = allContent.filter(content => content.isApproved);
    const unapprovedContent = allContent.filter(content => !content.isApproved);
    
    const contentByGrade = {};
    approvedContent.forEach(content => {
      if (!contentByGrade[content.gradeLevel]) {
        contentByGrade[content.gradeLevel] = [];
      }
      contentByGrade[content.gradeLevel].push(content);
    });
    
    const unapprovedByGrade = {};
    unapprovedContent.forEach(content => {
      if (!unapprovedByGrade[content.gradeLevel]) {
        unapprovedByGrade[content.gradeLevel] = [];
      }
      unapprovedByGrade[content.gradeLevel].push(content);
    });
    
    // Get student counts by grade
    const studentsByGrade = {};
    const allStudents = await User.find({ role: 'student' });
    allStudents.forEach(student => {
      const grade = student.gradeLevel || 'No Grade Assigned';
      if (!studentsByGrade[grade]) {
        studentsByGrade[grade] = 0;
      }
      studentsByGrade[grade]++;
    });
    
    res.json({
      success: true,
      approvedContentByGrade: contentByGrade,
      unapprovedContentByGrade: unapprovedByGrade,
      studentsByGrade: studentsByGrade,
      totalApprovedContent: approvedContent.length,
      totalUnapprovedContent: unapprovedContent.length,
      totalContent: allContent.length,
      totalStudents: allStudents.length
    });
  } catch (error) {
    console.error('Error fetching content distribution:', error);
    res.status(500).json({ success: false, message: 'Error fetching content distribution' });
  }
});

// Route for deleting content (admin only)
app.delete('/admin/delete-content/:contentId', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    console.log('Admin delete request for content:', contentId);
    
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }
    
    console.log('Found content to delete:', content.title);
    
    // Delete from S3
    if (content.fileUrl) {
      try {
        await deleteFromS3(content.fileUrl);
      } catch (s3Error) {
        console.error('Error deleting from S3:', s3Error);
        // Continue with database deletion even if S3 fails
      }
    }
    
    // Delete from database
    await Content.findByIdAndDelete(contentId);
    console.log('Content deleted from database:', contentId);
    
    res.json({ success: true, message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting content:', error);
    res.status(500).json({ success: false, message: 'Error deleting content: ' + error.message });
  }
});

// Route for approving content (admin only)
app.post('/admin/approve-content/:contentId', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }
    
    content.isApproved = true;
    await content.save();
    
    res.json({ success: true, message: 'Content approved successfully' });
  } catch (error) {
    console.error('Error approving content:', error);
    res.status(500).json({ success: false, message: 'Error approving content' });
  }
});

// Route for deleting content
app.delete('/teacher/delete-content/:contentId', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const { contentId } = req.params;
    
    console.log('Delete request for content:', contentId, 'by user:', req.user.email);
    
    // Verify the content belongs to this teacher
    const content = await Content.findOne({ _id: contentId, createdBy: req.user._id });
    if (!content) {
      console.log('Content not found or access denied for user:', req.user.email);
      return res.status(404).json({ success: false, message: 'Content not found or access denied' });
    }
    
    console.log('Found content to delete:', content.title);
    
    // Delete from S3
    if (content.fileUrl) {
      try {
        await deleteFromS3(content.fileUrl);
      } catch (s3Error) {
        console.error('Error deleting from S3:', s3Error);
        // Continue with database deletion even if S3 fails
      }
    }
    
    // Delete from database
    await Content.findByIdAndDelete(contentId);
    console.log('Content deleted from database:', contentId);
    
    res.json({ success: true, message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting content:', error);
    res.status(500).json({ success: false, message: 'Error deleting content: ' + error.message });
  }
});

// Route for admin to view all content (including unapproved)
app.get('/admin/content-management', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const allContent = await Content.find({})
      .populate('createdBy', 'displayName email')
      .sort({ createdAt: -1 });
    
    res.render('admin-content-management', {
      user: req.user,
      content: allContent
    });
  } catch (error) {
    console.error('Error fetching content for admin:', error);
    res.render('admin-content-management', {
      user: req.user,
      content: []
    });
  }
});

// Route for teacher's student results overview page
app.get('/teacher/student-results', isAuthenticated, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    // Get all quizzes created by this teacher
    const teacherQuizzes = await Quiz.find({ createdBy: req.user._id });
    const quizIds = teacherQuizzes.map(quiz => quiz._id);
    
    // Fetch all student results for teacher's quizzes
    const allResults = await QuizResult.find({ quiz: { $in: quizIds } })
      .populate('student', 'displayName email')
      .populate('quiz', 'title')
      .sort({ completedAt: -1 });
    
    // Group results by quiz
    const resultsByQuiz = {};
    teacherQuizzes.forEach(quiz => {
      resultsByQuiz[quiz._id] = {
        quiz: quiz,
        results: allResults.filter(result => result.quiz._id.toString() === quiz._id.toString())
      };
    });
    
    // Calculate overall statistics
    const totalAttempts = allResults.length;
    const uniqueStudents = new Set(allResults.map(result => result.student._id.toString())).size;
    const averageScore = totalAttempts > 0 
      ? Math.round(allResults.reduce((sum, result) => sum + result.percentage, 0) / totalAttempts)
      : 0;
    
    res.render('teacher-student-results', { 
      user: req.user, 
      resultsByQuiz,
      totalAttempts,
      uniqueStudents,
      averageScore,
      allResults
    });
  } catch (error) {
    console.error('Error fetching teacher student results:', error);
    res.status(500).send('Error fetching student results');
  }
});

// Debug route to check quiz results for a specific student
app.get('/debug-student-results/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    // Find the student by email
    const student = await User.findOne({ email: email });
    if (!student) {
      return res.json({ error: 'Student not found', email });
    }
    
    // Find all quiz results for this student
    const quizResults = await QuizResult.find({ student: student._id });
    
    res.json({
      student: {
        id: student._id,
        email: student.email,
        name: student.displayName
      },
      quizResultsCount: quizResults.length,
      quizResults: quizResults.map(result => ({
        id: result._id,
        quizTitle: result.quizTitle,
        score: result.score,
        percentage: result.percentage,
        completedAt: result.completedAt
      }))
    });
  } catch (error) {
    console.error('Error debugging student results:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check route
app.get('/health', async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    
    // Test MongoDB connection
    let mongoTest = 'Not tested';
    if (mongoose.connection.readyState === 1) {
      try {
        await mongoose.connection.db.admin().ping();
        mongoTest = 'Connected and responding';
      } catch (pingError) {
        mongoTest = 'Connected but not responding';
      }
    }
    
    res.json({
      status: 'ok',
      database: states[dbState],
      databaseState: dbState,
      mongoTest: mongoTest,
      mongodbUri: process.env.MONGO_URI ? 'Set' : 'Not Set',
      mongoDbUri: process.env.MONGODB_URI ? 'Set' : 'Not Set',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Route to view stored files
app.get('/view-files/:quizId', isAuthenticated, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).send('Quiz not found');
    }

    res.send(`
      <h1>Files for Quiz: ${quiz.title}</h1>
      <hr>
      <h2>Question Paper</h2>
      ${quiz.questionPaperUrl ? 
        `<p><a href="${quiz.questionPaperUrl}" target="_blank">View Question Paper</a></p>` : 
        '<p>No question paper stored</p>'
      }
      
      <h2>Answer Paper</h2>
      ${quiz.answerPaperUrl ? 
        `<p><a href="${quiz.answerPaperUrl}" target="_blank">View Answer Paper</a></p>` : 
        '<p>No answer paper stored</p>'
      }
      
      <hr>
      <p><a href="/teacher/dashboard">Back to Dashboard</a></p>
    `);
  } catch (error) {
    console.error('Error viewing files:', error);
    res.status(500).send('Error viewing files');
  }
});

// Test route for complete flow
app.get('/test-complete-flow', (req, res) => {
  const sampleQuestionText = `1. What is the capital of France?
A. London
B. Paris
C. Berlin
D. Madrid

2. Which planet is known as the Red Planet?
A. Venus
B. Mars
C. Jupiter
D. Saturn`;

  const sampleAnswerText = `1. B
2. B`;

      const questions = parseQuestionsFromText(sampleQuestionText, 'English');
  const answers = parseAnswersFromText(sampleAnswerText);
  const mergedQuestions = mergeQuestionsWithAnswers(questions, answers);

  res.json({
    questions: questions,
    answers: answers,
    mergedQuestions: mergedQuestions
  });
});

// Test route for actual format flow
app.get('/test-actual-flow', (req, res) => {
  const sampleQuestionText = `1. What is 456 + 287?
a) 733 b) 743 c) 643 d) 753

2. Round 3,847 to the nearest hundred.
a) 3,800 b) 3,900 c) 4,000 d) 3,850`;

  const actualAnswerText = `Answer Key
"1. B", "2. A"`;

      const questions = parseQuestionsFromText(sampleQuestionText, 'English');
  const answers = parseAnswersFromText(actualAnswerText);
  const mergedQuestions = mergeQuestionsWithAnswers(questions, answers);

  res.json({
    questions: questions,
    answers: answers,
    mergedQuestions: mergedQuestions
  });
});

// Route to delete a quiz
app.delete('/delete-quiz/:quizId', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }
    
    // Check if the teacher owns this quiz
    if (quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only delete your own quizzes' });
    }
    
    await Quiz.findByIdAndDelete(req.params.quizId);
    
    res.json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('Error deleting quiz:', error);
    res.status(500).json({ success: false, message: 'Error deleting quiz' });
  }
});

// Route to update student profile (grade level and subjects)
app.post('/update-student-profile', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    console.log('=== STUDENT PROFILE UPDATE DEBUG ===');
    console.log('Request body:', req.body);
    console.log('User ID:', req.user._id);
    console.log('User role:', req.user.role);
    
    const { gradeLevel, subjects } = req.body;
    
    console.log('Extracted data:', { gradeLevel, subjects });
    
    // Validate grade level
    const validGradeLevels = ['1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade', '9th grade', '10th grade', '11th grade', '12th grade'];
    if (gradeLevel && !validGradeLevels.includes(gradeLevel)) {
      console.log('Invalid grade level:', gradeLevel);
      return res.status(400).json({ success: false, message: 'Invalid grade level' });
    }
    
    // Validate subjects
    const validSubjects = ['English', 'Science', 'Math'];
    if (subjects && (!Array.isArray(subjects) || !subjects.every(subject => validSubjects.includes(subject)))) {
      console.log('Invalid subjects:', subjects);
      return res.status(400).json({ success: false, message: 'Invalid subjects' });
    }
    
    // Update user profile
    console.log('Updating student profile:', {
      userId: req.user._id,
      gradeLevel: gradeLevel,
      subjects: subjects
    });
    
    const updateData = {
      gradeLevel: gradeLevel || null,
      subjects: subjects || []
    };
    
    console.log('Update data:', updateData);
    
    // Use findOneAndUpdate instead of findByIdAndUpdate for better error handling
    const updatedUser = await User.findOneAndUpdate(
      { _id: req.user._id },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!updatedUser) {
      console.error('User not found for update');
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    console.log('Profile updated successfully:', {
      userId: updatedUser._id,
      gradeLevel: updatedUser.gradeLevel,
      subjects: updatedUser.subjects
    });
    
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating student profile:', error);
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
});

// Route to get student profile data
app.get('/student-profile', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    console.log('=== STUDENT PROFILE FETCH DEBUG ===');
    console.log('User ID:', req.user._id);
    console.log('User role:', req.user.role);
    
    const user = await User.findById(req.user._id);
    
    if (!user) {
      console.error('User not found');
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    console.log('Found user:', {
      _id: user._id,
      gradeLevel: user.gradeLevel,
      subjects: user.subjects
    });
    
    res.json({
      gradeLevel: user.gradeLevel,
      subjects: user.subjects || []
    });
  } catch (error) {
    console.error('Error fetching student profile:', error);
    res.status(500).json({ success: false, message: 'Error fetching profile' });
  }
});

// Temporary route to test quiz filtering (for debugging)
app.get('/test-quiz-filter', async (req, res) => {
  try {
    // Simulate a student with 4th grade profile
    const filter = { 
      isApproved: true,
      gradeLevel: '4th grade',
      subjects: { $in: ['Math'] }
    };
    
    console.log('Test filter:', filter);
    
    const quizzes = await Quiz.find(filter).select('title gradeLevel subjects');
    console.log('Found quizzes:', quizzes);
    
    res.json({
      filter: filter,
      quizzes: quizzes,
      count: quizzes.length
    });
  } catch (error) {
    console.error('Error testing filter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route to view available quizzes for students
app.get('/available-quizzes', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    // Get student's profile to filter quizzes
    const student = await User.findById(req.user._id);
    
    // Build filter based on student's grade level and subjects
    const filter = { isApproved: true };
    
    if (student.gradeLevel) {
      filter.gradeLevel = student.gradeLevel;
    }
    
    if (student.subjects && student.subjects.length > 0) {
      filter.subjects = { $in: student.subjects };
    }
    
    console.log('Student profile:', {
      gradeLevel: student.gradeLevel,
      subjects: student.subjects
    });
    
    console.log('Quiz filter:', filter);
    
    const approvedQuizzes = await Quiz.find(filter).populate('createdBy');
    
    console.log('Found quizzes matching filter:', approvedQuizzes.length);
    console.log('Quizzes found:', approvedQuizzes.map(q => ({ title: q.title, gradeLevel: q.gradeLevel, subjects: q.subjects })));
    
    // Get the student's quiz results to determine which quizzes they've taken
    const studentResults = await QuizResult.find({ 
      student: req.user._id 
    }).select('quiz score percentage timeTaken createdAt');
    
    // Create a map of quiz IDs and their attempt counts
    const quizAttempts = {};
    studentResults.forEach(result => {
      const quizId = result.quiz.toString();
      quizAttempts[quizId] = (quizAttempts[quizId] || 0) + 1;
    });
    
    res.render('available-quizzes', { 
      quizzes: approvedQuizzes.map(quiz => {
        const quizId = quiz._id.toString();
        const attemptCount = quizAttempts[quizId] || 0;
        const isTaken = attemptCount > 0;
        const canRetake = attemptCount < 3;
        const previousResult = isTaken ? studentResults.find(result => result.quiz.toString() === quizId) : null;
        
        return {
          ...quiz.toObject(),
          createdByName: quiz.createdBy.name,
          isTaken: isTaken,
          attemptCount: attemptCount,
          canRetake: canRetake,
          previousScore: previousResult ? previousResult.percentage : null,
          previousTime: previousResult ? previousResult.timeTaken : null
        };
      }), 
      user: req.user 
    });
  } catch (error) {
    console.error('Error fetching available quizzes:', error);
    res.status(500).send('Error fetching quizzes');
  }
});

// Route to start taking a quiz
app.get('/take-quiz/:quizId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).send('Quiz not found');
    }
    
    if (!quiz.isApproved) {
      return res.status(403).send('This quiz is not yet approved');
    }
    
    // Check if student has already taken this quiz and count attempts
    const existingResults = await QuizResult.find({
      student: req.user._id,
      quiz: quiz._id
    });
    
    const attemptCount = existingResults.length;
    
    // Check if student has reached the retake limit (3 attempts)
    if (attemptCount >= 3) {
      return res.status(403).render('error', {
        error: 'Maximum attempts reached',
        message: `You have already taken this quiz ${attemptCount} times. The maximum allowed attempts is 3.`,
        user: req.user
      });
    }
    
    res.render('take-quiz', { quiz, user: req.user });
  } catch (error) {
    console.error('Error starting quiz:', error);
    res.status(500).send('Error starting quiz');
  }
});

// Route to submit quiz answers
app.post('/submit-quiz/:quizId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }
    
    const { answers, timeTaken } = req.body;
    const answersArray = Array.isArray(answers) ? answers : [];
    
    // Calculate results
    let correctAnswers = 0;
    let totalPoints = 0;
    const processedAnswers = [];
    
    quiz.questions.forEach((question, index) => {
      // Extract selectedAnswer properly from the answers array
      let selectedAnswer = '';
      if (answersArray[index] && typeof answersArray[index] === 'object') {
        selectedAnswer = answersArray[index].selectedAnswer || '';
      } else if (typeof answersArray[index] === 'string') {
        selectedAnswer = answersArray[index];
      }
      
      const isCorrect = selectedAnswer === question.correctAnswer;
      
      if (isCorrect) {
        correctAnswers++;
        totalPoints += question.points;
      }
      
      processedAnswers.push({
        questionIndex: index,
        selectedAnswer: selectedAnswer,
        correctAnswer: question.correctAnswer,
        isCorrect: isCorrect,
        points: question.points
      });
    });
    
    const score = totalPoints;
    const percentage = Math.round((correctAnswers / quiz.questions.length) * 100);
    
    // Save quiz result
    const quizResult = new QuizResult({
      student: req.user._id,
      studentName: req.user.displayName,
      quiz: quiz._id,
      quizTitle: quiz.title,
      answers: processedAnswers,
      totalQuestions: quiz.questions.length,
      correctAnswers: correctAnswers,
      totalPoints: quiz.questions.reduce((sum, q) => sum + q.points, 0),
      score: score,
      percentage: percentage,
      timeTaken: timeTaken || 0,
      completedAt: new Date()
    });
    
    await quizResult.save();
    
    res.json({ 
      success: true, 
      resultId: quizResult._id,
      score: score,
      percentage: percentage,
      correctAnswers: correctAnswers,
      totalQuestions: quiz.questions.length
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ success: false, message: 'Error submitting quiz' });
  }
});

// Route to view quiz result
app.get('/quiz-result/:resultId', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const result = await QuizResult.findById(req.params.resultId)
      .populate('quiz')
      .populate('student');
    
    if (!result) {
      return res.status(404).send('Result not found');
    }
    
    // Check if the student owns this result
    if (result.student._id.toString() !== req.user._id.toString()) {
      return res.status(403).send('Access denied');
    }
    
    res.render('quiz-result', { result, user: req.user });
  } catch (error) {
    console.error('Error viewing quiz result:', error);
    res.status(500).send('Error viewing result');
  }
});

// Route to fix existing quiz options
app.post('/fix-quiz-options/:quizId', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    
    // Check if the teacher owns this quiz
    if (quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only fix your own quizzes' });
    }
    
    // Fix each question to have exactly 4 options
    quiz.questions.forEach((question, index) => {
      console.log(`Fixing question ${index + 1}: ${question.options.length} options`);
      console.log(`Question ${index + 1} original options:`, question.options);
      
      // AGGRESSIVE FIX: Force exactly 4 options
      if (question.options.length < 4) {
        while (question.options.length < 4) {
          const newOption = `Option ${String.fromCharCode(65 + question.options.length)}`;
          question.options.push(newOption);
          console.log(`Question ${index + 1} added option: ${newOption}`);
        }
      } else if (question.options.length > 4) {
        question.options = question.options.slice(0, 4);
        console.log(`Question ${index + 1} trimmed to 4 options`);
      }
      
      console.log(`Question ${index + 1} after fix: ${question.options.length} options`);
      console.log(`Question ${index + 1} final options:`, question.options);
    });
    
    await quiz.save();
    res.json({ 
      success: true, 
      message: 'Quiz options fixed to 4 options per question',
      quizId: quiz._id 
    });
  } catch (error) {
    console.error('Error fixing quiz options:', error);
    res.status(500).json({ error: 'Error fixing quiz options' });
  }
});

// Route to recreate quiz with fixed parsing
app.post('/recreate-quiz/:quizId', isAuthenticated, requireRole(['teacher']), async (req, res) => {
  try {
    const originalQuiz = await Quiz.findById(req.params.quizId);
    if (!originalQuiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    
    // Check if the teacher owns this quiz
    if (originalQuiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only recreate your own quizzes' });
    }
    
    // Create a new quiz with the same title and description
    const newQuiz = new Quiz({
      title: originalQuiz.title + ' (Updated)',
      description: originalQuiz.description,
      gradeLevel: originalQuiz.gradeLevel,
      subjects: originalQuiz.subjects,
      language: originalQuiz.language || 'English', // Include language with fallback
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      isApproved: false, // New quiz needs approval
      questions: originalQuiz.questions.map(q => ({
        ...q,
        options: q.options.length < 4 ? 
          [...q.options, ...Array(4 - q.options.length).fill().map((_, i) => 
            `Option ${String.fromCharCode(65 + q.options.length + i)}`
          )] : 
          q.options.slice(0, 4)
      }))
    });
    
    await newQuiz.save();
    res.json({ 
      success: true, 
      message: 'Quiz recreated with 4 options per question',
      newQuizId: newQuiz._id 
    });
  } catch (error) {
    console.error('Error recreating quiz:', error);
    res.status(500).json({ error: 'Error recreating quiz' });
  }
});

// Debug route to check quiz data
app.get('/debug-quiz/:quizId', isAuthenticated, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    
    res.json({
      title: quiz.title,
      questionsCount: quiz.questions.length,
      questions: quiz.questions.map((q, index) => ({
        questionNumber: index + 1,
        question: q.question,
        optionsCount: q.options.length,
        options: q.options,
        correctAnswer: q.correctAnswer
      }))
    });
  } catch (error) {
    console.error('Error fetching quiz debug info:', error);
    res.status(500).json({ error: 'Error fetching quiz info' });
  }
});

// Route to view student's quiz history
app.get('/my-results', isAuthenticated, requireRole(['student']), async (req, res) => {
  try {
    const results = await QuizResult.find({ student: req.user._id })
      .populate('quiz')
      .sort({ createdAt: -1 });
    
    res.render('my-results', { results, user: req.user });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).send('Error fetching results');
  }
});

// Route to view quiz questions in database
app.get('/view-quiz/:quizId', isAuthenticated, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId).populate('createdBy');
    if (!quiz) {
      return res.status(404).send('Quiz not found');
    }
    
    res.render('view-quiz', { quiz });
  } catch (error) {
    console.error('Error viewing quiz:', error);
    res.status(500).send('Error viewing quiz');
  }
});

// Simple test route to create admin (for debugging)
app.get('/test-create-admin', async (req, res) => {
  try {
    // Check MongoDB connection
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({
        error: 'MongoDB not connected',
        state: mongoose.connection.readyState,
        message: 'Database connection failed'
      });
    }
    
    // Create admin user
    const adminUser = new User({
      googleId: 'test-admin-' + Date.now(),
      displayName: 'Test Admin',
      email: 'sarika.katti@gmail.com',
      role: 'admin',
      isApproved: true
    });
    
    await adminUser.save();
    
    res.json({
      success: true,
      message: 'Admin created successfully',
      userId: adminUser._id,
      mongoState: mongoose.connection.readyState
    });
  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).json({
      error: error.message,
      mongoState: mongoose.connection.readyState,
      stack: error.stack
    });
  }
});

// Route to make current user admin (for development)
app.get('/make-admin', isAuthenticated, async (req, res) => {
  try {
    if (req.user.email === 'skillonusers@gmail.com') {
      req.user.role = 'admin';
      req.user.isApproved = true;
      await req.user.save();
      res.send(`
        <h2>✅ You are now an Admin!</h2>
        <p><strong>Email:</strong> ${req.user.email}</p>
        <p><strong>Name:</strong> ${req.user.displayName}</p>
        <br>
        <p>You can now access the admin dashboard.</p>
        <a href="/admin/dashboard">Go to Admin Dashboard</a>
      `);
    } else {
      res.send(`
        <h2>❌ Access Denied</h2>
        <p>Only skillonusers@gmail.com can become admin.</p>
        <a href="/dashboard">Go to Dashboard</a>
      `);
    }
  } catch (error) {
    console.error('Error making user admin:', error);
    res.status(500).send('Error making user admin');
  }
});

// Test MongoDB connection
app.get('/test-db', async (req, res) => {
  try {
    // Test database connection
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    
    if (dbState === 1) { // Connected
      // Test user count
      const userCount = await User.countDocuments();
      res.send(`
        <h1>MongoDB Connection Test</h1>
        <p>✅ Connection State: ${states[dbState]} (${dbState})</p>
        <p>✅ Database connected successfully!</p>
        <p>📊 Total Users: ${userCount}</p>
        <hr>
        <h2>Test Database Operations</h2>
        <p>✅ User count query successful</p>
        <p><a href="/login">Go to Login</a></p>
      `);
    } else {
      res.send(`
        <h1>MongoDB Connection Test</h1>
        <p>❌ Connection State: ${states[dbState]} (${dbState})</p>
        <p>❌ Database not connected</p>
        <p>Please check MongoDB Atlas IP whitelist</p>
        <p><a href="/login">Go to Login</a></p>
      `);
    }
  } catch (error) {
    res.send(`
      <h1>MongoDB Connection Test</h1>
      <p>❌ Error: ${error.message}</p>
      <p>Please check MongoDB Atlas IP whitelist</p>
      <p><a href="/login">Go to Login</a></p>
    `);
  }
});

// Simple test route
app.get('/test', (req, res) => {
  res.send(`
    <h1>Server is Working!</h1>
    <p>✅ Server is responding</p>
    <p>✅ Routes are working</p>
    <p><a href="/debug-user">Check User State</a></p>
    <p><a href="/test-db">Check Database</a></p>
    <p><a href="/create-admin">Create Admin</a></p>
  `);
});

// Test session state (SECURE VERSION)
app.get('/test-session', (req, res) => {
  res.send(`
    <h1>Session Test</h1>
    <p><strong>req.isAuthenticated():</strong> ${req.isAuthenticated()}</p>
    <p><strong>User ID:</strong> ${req.user ? req.user._id : 'null'}</p>
    <p><strong>User Role:</strong> ${req.user ? req.user.role : 'null'}</p>
    <p><strong>Session ID:</strong> ${req.sessionID ? 'Set' : 'No session'}</p>
    <p><strong>Session Active:</strong> ${req.session ? 'Yes' : 'No'}</p>
    <hr>
    <p><a href="/login">Go to Login</a></p>
    <p><a href="/dashboard">Go to Dashboard</a></p>
  `);
});

// Debug user state
app.get('/debug-user', async (req, res) => {
  try {
    const email = 'sarika.katti@gmail.com';
    const user = await User.findOne({ email });
    
    if (user) {
      res.send(`
        <h1>User Debug Information</h1>
        <p><strong>Email:</strong> ${user.email}</p>
        <p><strong>Display Name:</strong> ${user.displayName}</p>
        <p><strong>Role:</strong> ${user.role || 'NOT SET'}</p>
        <p><strong>Is Approved:</strong> ${user.isApproved}</p>
        <p><strong>Google ID:</strong> ${user.googleId}</p>
        <p><strong>User ID:</strong> ${user._id}</p>
        <hr>
        <h2>Actions</h2>
        <p><a href="/create-admin">Create Admin User</a></p>
        <p><a href="/select-role">Select Role</a></p>
        <p><a href="/login">Go to Login</a></p>
      `);
    } else {
      res.send(`
        <h1>User Debug Information</h1>
        <p>❌ User not found with email: ${email}</p>
        <p><a href="/create-admin">Create Admin User</a></p>
        <p><a href="/login">Go to Login</a></p>
      `);
    }
  } catch (error) {
    res.send(`
      <h1>User Debug Information</h1>
      <p>❌ Error: ${error.message}</p>
      <p><a href="/login">Go to Login</a></p>
    `);
  }
});

// Temporary route to create admin (remove in production)
app.get('/create-admin', async (req, res) => {
  try {
    // Check if admin already exists for your email
    const existingAdmin = await User.findOne({ email: 'sarika.katti@gmail.com' });
    if (existingAdmin) {
      existingAdmin.role = 'admin';
      existingAdmin.isApproved = true;
      await existingAdmin.save();
      res.send(`
        <h2>Admin User Updated Successfully!</h2>
        <p><strong>Admin ID:</strong> ${existingAdmin._id}</p>
        <p><strong>Email:</strong> ${existingAdmin.email}</p>
        <p><strong>Name:</strong> ${existingAdmin.displayName}</p>
        <p><strong>Role:</strong> ${existingAdmin.role}</p>
        <br>
        <p>You can now log in with Google and the system will recognize you as an admin.</p>
        <a href="/login">Go to Login</a>
      `);
    } else {
      // Create new admin user
      const adminUser = new User({
        googleId: 'admin-' + Date.now(),
        displayName: 'System Administrator',
        email: 'sarika.katti@gmail.com',
        role: 'admin',
        isApproved: true
      });
      
      await adminUser.save();
      res.send(`
        <h2>Admin User Created Successfully!</h2>
        <p><strong>Admin ID:</strong> ${adminUser._id}</p>
        <p><strong>Email:</strong> ${adminUser.email}</p>
        <p><strong>Name:</strong> ${adminUser.displayName}</p>
        <br>
        <p>You can now log in with Google and the system will recognize you as an admin.</p>
        <a href="/login">Go to Login</a>
      `);
    }
  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).send(`
      <h2>Error Creating Admin</h2>
      <p>Error: ${error.message}</p>
      <a href="/login">Go to Login</a>
    `);
  }
});

// Alternative route without hyphen
app.get('/createadmin', async (req, res) => {
  try {
    // Check if admin already exists for your email
    const existingAdmin = await User.findOne({ email: 'sarika.katti@gmail.com' });
    if (existingAdmin) {
      existingAdmin.role = 'admin';
      existingAdmin.isApproved = true;
      await existingAdmin.save();
      res.send(`
        <h2>Admin User Updated Successfully!</h2>
        <p><strong>Admin ID:</strong> ${existingAdmin._id}</p>
        <p><strong>Email:</strong> ${existingAdmin.email}</p>
        <p><strong>Name:</strong> ${existingAdmin.displayName}</p>
        <p><strong>Role:</strong> ${existingAdmin.role}</p>
        <br>
        <p>You can now log in with Google and the system will recognize you as an admin.</p>
        <a href="/login">Go to Login</a>
      `);
    } else {
      // Create new admin user
      const adminUser = new User({
        googleId: 'admin-' + Date.now(),
        displayName: 'System Administrator',
        email: 'sarika.katti@gmail.com',
        role: 'admin',
        isApproved: true
      });
      
      await adminUser.save();
      res.send(`
        <h2>Admin User Created Successfully!</h2>
        <p><strong>Admin ID:</strong> ${adminUser._id}</p>
        <p><strong>Email:</strong> ${adminUser.email}</p>
        <p><strong>Name:</strong> ${adminUser.displayName}</p>
        <br>
        <p>You can now log in with Google and the system will recognize you as an admin.</p>
        <a href="/login">Go to Login</a>
      `);
    }
  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).send(`
      <h2>Error Creating Admin</h2>
      <p>Error: ${error.message}</p>
      <a href="/login">Go to Login</a>
    `);
  }
});

// Admin approval routes
app.post('/approve-teacher/:userId', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (user && user.role === 'teacher') {
      user.isApproved = true;
      await user.save();
    }
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Error approving teacher:', error);
    res.redirect('/admin/dashboard');
  }
});

app.post('/approve-quiz/:quizId', isAuthenticated, requireRole(['admin']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (quiz) {
      quiz.isApproved = true;
      await quiz.save();
    }
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Error approving quiz:', error);
    res.redirect('/admin/dashboard');
  }
});

// Google OAuth routes
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login?error=Google OAuth not configured');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res);
});

app.get('/auth/google/callback', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login?error=Google OAuth not configured');
  }
  
  passport.authenticate('google', { 
    failureRedirect: '/login',
    failureFlash: true
  })(req, res, (err) => {
    if (err) {
      console.error('Google OAuth callback error:', err);
      
      // Handle specific SaaS-related errors
      if (err.message.includes('must be invited') || err.message.includes('create an organization')) {
        return res.redirect('/teacher-signup?error=Please create an organization or ask a teacher for an invitation');
      }
      
      return res.redirect('/login?error=Authentication failed');
    }
    
    // Check if user exists and has a role
    if (!req.user) {
      console.error('User not found after Google OAuth authentication');
      return res.redirect('/login?error=Authentication failed');
    }
    
    console.log('User authenticated successfully:', req.user._id);
    
    // For SaaS: Check if user has organization context
    if (req.user.role !== 'super_admin' && !req.user.organizationId) {
      console.log('User without organization context, redirecting to signup');
      return res.redirect('/teacher-signup?error=Please create an organization first');
    }
    
    // Add null check for req.user.role
    if (!req.user || !req.user.role) {
      return res.redirect('/select-role');
    }
    
    // Redirect based on organization context
    if (req.user.organizationRole === 'owner' && req.user.role === 'teacher') {
      res.redirect('/organization/dashboard');
    } else {
      res.redirect('/dashboard');
    }
  });
});

// API routes for session management
app.post('/api/activity-update', isAuthenticated, (req, res) => {
  // Update session last activity
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  res.json({ success: true });
});

app.post('/api/extend-session', isAuthenticated, (req, res) => {
  // Extend session by updating last activity
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  res.json({ success: true, message: 'Session extended' });
});

// Logout route with timeout parameter
app.get('/logout', (req, res) => {
  const timeout = req.query.timeout === 'true';
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    if (timeout) {
      res.redirect('/login?timeout=true');
    } else {
      res.redirect('/');
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', { error: 'Page not found!' });
});

// Temporary login route for testing (remove this in production)
app.get('/temp-login', (req, res) => {
  res.render('temp-login', { error: null });
});

app.post('/temp-login', (req, res) => {
  const { email, role } = req.body;
  
  if (!email || !role) {
    return res.render('temp-login', { error: 'Please provide email and role' });
  }
  
  // Create a temporary user session
  req.session.user = {
    _id: 'temp-' + Date.now(),
    displayName: email.split('@')[0],
    email: email,
    role: role,
    isApproved: role === 'student' ? true : false,
    photos: []
  };
  
  res.redirect('/dashboard');
});

// Start server with MongoDB connection check
const startServer = () => {
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log('✅ Google OAuth is configured and ready!');
    console.log('👥 Role-based system: Teachers, Students, and Admins');
    console.log(`🗄️  MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
  });
};

// Wait for MongoDB connection before starting server
const checkConnectionAndStart = () => {
  if (mongoose.connection.readyState === 1) {
    console.log('✅ MongoDB connected, starting server...');
    startServer();
  } else {
    console.log('⏳ Waiting for MongoDB connection...');
    console.log('Current MongoDB state:', mongoose.connection.readyState);
    console.log('MongoDB connection status:', mongoose.connection.readyState === 1 ? 'Connected' : 'Not Connected');
    setTimeout(checkConnectionAndStart, 2000);
  }
};

// Debug environment variables
console.log('🔍 Environment Variables Debug:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('MONGO_URI exists:', !!process.env.MONGO_URI);
console.log('MONGODB_URI exists:', !!process.env.MONGODB_URI);
console.log('All env vars with MONGO:', Object.keys(process.env).filter(key => key.includes('MONGO')));

// Start the connection check process after a delay to allow MongoDB to connect
setTimeout(checkConnectionAndStart, 3000); 