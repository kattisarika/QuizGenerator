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
const quizSessionRoutes = require('./routes/quizSession');
const whiteboardRoutes = require('./routes/whiteboard');


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

    // Clean up any existing teachers without organizationId (except super_admin)
    try {
      const invalidTeachers = await User.find({
        role: 'teacher',
        email: { $ne: 'skillonusers@gmail.com' }, // Exclude super admin
        $or: [
          { organizationId: null },
          { organizationId: { $exists: false } }
        ]
      });

      if (invalidTeachers.length > 0) {
        console.log(`🧹 Found ${invalidTeachers.length} teachers without organizationId. Cleaning up...`);

        // Log the teachers being removed
        invalidTeachers.forEach(teacher => {
          console.log(`  ❌ Removing invalid teacher: ${teacher.email} (ID: ${teacher._id})`);
        });

        // Remove invalid teachers
        const result = await User.deleteMany({
          _id: { $in: invalidTeachers.map(t => t._id) }
        });

        console.log(`✅ Successfully removed ${result.deletedCount} invalid teacher accounts`);
      } else {
        console.log('✅ No invalid teacher accounts found');
      }
    } catch (cleanupError) {
      console.error('❌ Error during teacher cleanup:', cleanupError);
    }
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

// Middleware functions - defined early to avoid hoisting issues
const requireAuth = (req, res, next) => {
  console.log('requireAuth middleware called');
  console.log('req.user:', req.user);
  console.log('req.isAuthenticated type:', typeof req.isAuthenticated);
  console.log('req.isAuthenticated:', req.isAuthenticated);
  
  if (req.isAuthenticated && req.isAuthenticated()) {
    console.log('User is authenticated, proceeding');
    return next();
  }
  
  console.log('User not authenticated, redirecting to login');
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

// Middleware with increased payload limits for complex quizzes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Multer configuration for document uploads (S3)
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

// Multer configuration for quiz image uploads (S3)
const quizImageUpload = multer({
  storage: multer.memoryStorage(), // Store in memory temporarily
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, JPEG, PNG, GIF, and WebP image files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for images
  }
});

// Multer configuration for audio uploads (S3)
const audioUpload = multer({
  storage: multer.memoryStorage(), // Store in memory temporarily
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only MP3, WAV, OGG, M4A, and AAC audio files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit for audio files
  }
});

// Helper function to upload file to S3 and return S3 key
async function uploadToS3(file, folder = 'uploads') {
  const s3Key = `${folder}/${Date.now()}-${file.originalname}`;
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: s3Key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: 'public-read' // Make images public for direct access
  };

  try {
    const result = await s3.upload(params).promise();
    console.log(`✅ File uploaded to S3: ${s3Key}`);
    return s3Key; // Return S3 key instead of full URL
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

// Helper function to generate pre-signed URL for S3 objects
async function generatePresignedUrl(s3Key, expiresIn = 3600) {
  try {
    if (!s3Key) {
      console.warn('⚠️  No S3 key provided for pre-signed URL generation');
      return null;
    }

    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      Expires: expiresIn // URL expires in 1 hour by default
    };

    const presignedUrl = await s3.getSignedUrlPromise('getObject', params);
    console.log(`🔗 Generated pre-signed URL for: ${s3Key} (expires in ${expiresIn}s)`);
    return presignedUrl;
  } catch (error) {
    console.error('❌ Error generating pre-signed URL:', error);
    return null;
  }
}

// Helper function to make an S3 object public
async function makeS3ObjectPublic(s3Key) {
  try {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      ACL: 'public-read'
    };

    await s3.putObjectAcl(params).promise();
    console.log(`✅ Made S3 object public: ${s3Key}`);
    return true;
  } catch (error) {
    console.error(`❌ Error making S3 object public: ${s3Key}`, error);
    return false;
  }
}

// Helper function to generate pre-signed URLs for multiple S3 objects
async function generatePresignedUrls(s3Keys, expiresIn = 3600) {
  try {
    if (!Array.isArray(s3Keys)) {
      console.warn('⚠️  s3Keys is not an array, converting to array');
      s3Keys = [s3Keys];
    }

    const presignedUrls = await Promise.all(
      s3Keys.map(async (s3Key) => {
        if (typeof s3Key === 'object' && s3Key.s3Key) {
          // Handle case where we have an object with s3Key property
          const presignedUrl = await generatePresignedUrl(s3Key.s3Key, expiresIn);
          return {
            ...s3Key,
            url: presignedUrl,
            presignedUrl: presignedUrl
          };
        } else if (typeof s3Key === 'string') {
          // Handle case where we have a direct S3 key
          const presignedUrl = await generatePresignedUrl(s3Key, expiresIn);
          return {
            s3Key: s3Key,
            url: presignedUrl,
            presignedUrl: presignedUrl
          };
        }
        return s3Key;
      })
    );

    console.log(`🔗 Generated ${presignedUrls.length} pre-signed URLs`);
    return presignedUrls;
  } catch (error) {
    console.error('❌ Error generating pre-signed URLs:', error);
    return s3Keys; // Return original keys if generation fails
  }
}

// Helper function to make existing S3 objects public
async function makeS3ObjectPublic(s3Key) {
  try {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      ACL: 'public-read'
    };

    await s3.putObjectAcl(params).promise();
    console.log(`✅ Made S3 object public: ${s3Key}`);
    return true;
  } catch (error) {
    console.error(`❌ Error making S3 object public: ${s3Key}`, error);
    return false;
  }
}



// API endpoint to get a single pre-signed URL for an image
app.get('/api/image/:s3Key', requireAuth, async (req, res) => {
  try {
    const { s3Key } = req.params;
    const { expiresIn = 3600 } = req.query; // Default 1 hour

    console.log(`🔗 Generating pre-signed URL for image: ${s3Key}`);

    // Generate pre-signed URL
    const presignedUrl = await generatePresignedUrl(s3Key, parseInt(expiresIn));

    if (!presignedUrl) {
      return res.status(404).json({ error: 'Image not found' });
    }

    console.log(`✅ Generated pre-signed URL for image: ${s3Key}`);
    res.json({
      presignedUrl,
      expiresIn: parseInt(expiresIn),
      s3Key
    });

  } catch (error) {
    console.error('❌ Error generating pre-signed URL:', error);
    res.status(500).json({ error: 'Failed to generate image URL' });
  }
});

// API endpoint to get a single pre-signed URL for an audio file
app.get('/api/audio/:s3Key(*)', requireAuth, async (req, res) => {
  try {
    const s3Key = req.params.s3Key;
    const { expiresIn = 3600 } = req.query; // Default 1 hour

    console.log(`🎵 Generating pre-signed URL for audio: ${s3Key}`);

    // Generate pre-signed URL
    const presignedUrl = await generatePresignedUrl(s3Key, parseInt(expiresIn));

    if (!presignedUrl) {
      console.error(`❌ Audio file not found: ${s3Key}`);
      return res.status(404).json({ error: 'Audio file not found' });
    }

    console.log(`✅ Generated pre-signed URL for audio: ${s3Key}`);
    res.json({
      presignedUrl,
      expiresIn: parseInt(expiresIn),
      s3Key
    });

  } catch (error) {
    console.error('❌ Error generating pre-signed URL for audio:', error);
    res.status(500).json({ error: 'Failed to generate audio URL' });
  }
});

// API endpoint to make existing S3 images public
app.post('/api/make-image-public/:s3Key', requireAuth, requireRole(['teacher', 'admin']), async (req, res) => {
  try {
    const { s3Key } = req.params;
    
    console.log(`🔓 Making S3 image public: ${s3Key}`);
    
    const success = await makeS3ObjectPublic(s3Key);
    
    if (success) {
      res.json({ 
        success: true, 
        message: `Image ${s3Key} is now public`,
        s3Key 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to make image public' 
      });
    }

  } catch (error) {
    console.error('❌ Error making image public:', error);
    res.status(500).json({ error: 'Failed to make image public' });
  }
});

// API endpoint to get pre-signed URLs for quiz question images
app.get('/api/quiz/:quizId/question-images', requireAuth, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { expiresIn = 3600 } = req.query; // Default 1 hour

    console.log(`🔗 Generating pre-signed URLs for quiz ${quizId} question images`);

    // Find the quiz
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Check if user has access to this quiz
    if (quiz.organizationId && req.user.organizationId) {
      if (quiz.organizationId.toString() !== req.user.organizationId.toString()) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (!quiz.questions || quiz.questions.length === 0) {
      return res.json({ questionImages: [] });
    }

    // Extract S3 keys from questions that have images
    const questionImages = quiz.questions
      .filter(q => q.image) // Only questions with images
      .map((q, index) => ({
        questionIndex: index,
        questionNumber: q.questionNumber || index + 1,
        s3Key: q.image,
        type: q.type
      }));

    if (questionImages.length === 0) {
      return res.json({ questionImages: [] });
    }

    // Generate pre-signed URLs for all question images
    const imagesWithUrls = await generatePresignedUrls(
      questionImages.map(img => img.s3Key), 
      parseInt(expiresIn)
    );

    // Map back to original structure with pre-signed URLs
    const result = questionImages.map((img, index) => ({
      ...img,
      url: imagesWithUrls[index]?.url || null,
      presignedUrl: imagesWithUrls[index]?.url || null
    }));

    console.log(`✅ Generated ${result.length} pre-signed URLs for quiz ${quizId} question images`);
    res.json({ questionImages: result });

  } catch (error) {
    console.error('❌ Error generating pre-signed URLs for question images:', error);
    res.status(500).json({ error: 'Failed to generate question image URLs' });
  }
});

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
          
          // Check if there are temporary users created during organization signup
          const tempUsers = await User.find({ 
            email: userEmail, 
            googleId: { $regex: /^temp_/ } 
          });
          
          if (tempUsers.length > 0) {
            console.log(`Found ${tempUsers.length} temporary user(s) for ${userEmail}`);
            
            // Update the first temp user as the primary account
            const primaryUser = tempUsers[0];

            // Validate that teacher has organizationId before completing OAuth
            if (primaryUser.role === 'teacher' && !primaryUser.organizationId) {
              console.error('Temporary teacher user missing organizationId:', primaryUser.email);
              // Clean up invalid temporary users
              try {
                const tempUserIds = tempUsers.map(u => u._id);
                await User.deleteMany({ _id: { $in: tempUserIds } });
                console.log('Deleted invalid temporary teacher users');
              } catch (deleteError) {
                console.error('Error deleting invalid temporary users:', deleteError);
              }
              return cb(new Error('Teacher account setup incomplete. Please create an organization first.'), null);
            }

            primaryUser.googleId = profile.id;
            primaryUser.displayName = profile.displayName;
            primaryUser.photos = profile.photos;

            // If there are multiple organizations, store them in an array for future org switching
            if (tempUsers.length > 1) {
              primaryUser.organizationMemberships = tempUsers.map(u => ({
                organizationId: u.organizationId,
                role: u.organizationRole || 'student',
                gradeLevel: u.gradeLevel,
                subjects: u.subjects,
                joinedAt: u.createdAt || new Date()
              }));
            }

            try {
              await primaryUser.save();
              console.log(`Primary user updated with ${tempUsers.length} organization(s)`);

              // Delete the duplicate temporary users (keep only the primary one)
              if (tempUsers.length > 1) {
                const duplicateIds = tempUsers.slice(1).map(u => u._id);
                await User.deleteMany({ _id: { $in: duplicateIds } });
                console.log(`Removed ${duplicateIds.length} duplicate temporary users`);
              }

              user = primaryUser;
            } catch (saveError) {
              console.error('Error updating temporary users:', saveError);
              // If save fails due to validation, clean up the temp users
              if (saveError.name === 'ValidationError' && saveError.message.includes('organizationId')) {
                try {
                  const tempUserIds = tempUsers.map(u => u._id);
                  await User.deleteMany({ _id: { $in: tempUserIds } });
                  console.log('Deleted invalid temporary users after validation error');
                } catch (deleteError) {
                  console.error('Error deleting invalid temporary users:', deleteError);
                }
                return cb(new Error('Teacher account validation failed. Please create an organization first.'), null);
              }
              return cb(new Error('Failed to update users'), null);
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

          // Validate existing teacher users have organizationId
          if (user.role === 'teacher' && user.email !== 'skillonusers@gmail.com' && !user.organizationId) {
            console.error('Existing teacher user missing organizationId:', user.email);
            return cb(new Error('Teacher account incomplete. Please contact administrator to assign an organization.'), null);
          }

          // Existing user - check if they should be super admin
          if (user.email === 'skillonusers@gmail.com' && user.role !== 'super_admin') {
            user.role = 'super_admin';
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

// Quiz Session routes for competitive quizzes
app.use('/api/quiz-session', quizSessionRoutes);



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

// Middleware functions removed - now defined at the top of the file

// Routes
app.get('/', async (req, res) => {
  try {
    // Fetch all teachers with their organization information
    const teachers = await User.find({ 
      role: 'teacher', 
      isApproved: true,
      organizationId: { $exists: true, $ne: null }
    })
    .populate('organizationId', 'name subdomain')
    .select('displayName organizationId organizationRole')
    .sort({ displayName: 1 });

    res.render('index', { 
      user: req.user,
      teachers: teachers || []
    });
  } catch (error) {
    console.error('Error fetching teachers for homepage:', error);
    res.render('index', { 
      user: req.user,
      teachers: []
    });
  }
});

// SaaS Teacher Signup Route
// User signup route - handles both teachers and students
app.get('/signup', async (req, res) => {
  try {
    // Fetch all available organizations for student selection
    const organizations = await Organization.find({})
      .select('name subdomain')
      .sort({ name: 1 });
    
    res.render('user-signup', { 
      title: 'Join SkillOns - Choose Your Role',
      organizations: organizations || []
    });
  } catch (error) {
    console.error('Error fetching organizations for signup:', error);
    res.render('user-signup', { 
      title: 'Join SkillOns - Choose Your Role',
      organizations: []
    });
  }
});

// Legacy teacher signup redirect
app.get('/teacher-signup', (req, res) => {
  res.redirect('/signup');
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  const error = req.query.error || null;
  const timeout = req.query.timeout === 'true';
  res.render('login', { error, timeout });
});

app.get('/dashboard', requireAuth, (req, res) => {
  // Add null check for req.user
  if (!req.user) {
    console.error('User not found in dashboard route');
    return res.redirect('/login?error=Authentication failed');
  }
  
  // If user doesn't have a role, redirect to login with error
  if (!req.user.role) {
    return res.redirect('/login?error=User role not set. Please contact administrator.');
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
  } else if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    return res.redirect('/admin/dashboard');
  }
  
  // Fallback to dashboard template
  res.render('dashboard', { user: req.user });
});

// API endpoint to get content file URL for external viewers
app.get('/api/content-url/:contentId', requireAuth, requireRole(['student']), async (req, res) => {
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
app.get('/api/signed-url/:contentId', requireAuth, requireRole(['student']), async (req, res) => {
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

// Teacher API routes for competitive quizzes
app.get('/api/teacher/competitive-quizzes', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const quizzes = await Quiz.find({ 
      createdBy: req.user._id,
      quizType: 'competitive'
    }).select('title questions createdAt');
    
    res.json({ success: true, quizzes });
  } catch (error) {
    console.error('Error fetching competitive quizzes:', error);
    res.status(500).json({ success: false, message: 'Error fetching quizzes' });
  }
});

app.get('/api/teacher/active-sessions', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const QuizSession = require('./models/QuizSession');
    const sessions = await QuizSession.find({
      teacher: req.user._id,
      status: { $in: ['scheduled', 'waiting', 'in-progress'] }
    }).populate('quiz', 'title');
    
    const sessionData = sessions.map(s => ({
      id: s._id,
      sessionCode: s.sessionCode,
      quizTitle: s.quizTitle,
      scheduledStartTime: s.scheduledStartTime,
      status: s.status,
      participantCount: s.participants.length,
      maxParticipants: s.maxParticipants,
      canStart: s.canStart()
    }));
    
    res.json({ success: true, sessions: sessionData });
  } catch (error) {
    console.error('Error fetching active sessions:', error);
    res.status(500).json({ success: false, message: 'Error fetching sessions' });
  }
});

// Competitive quiz management page (Teacher)
app.get('/competitive-quiz', requireAuth, requireRole(['teacher']), requireApprovedTeacher, (req, res) => {
  res.render('competitive-quiz', { user: req.user });
});

// Join competitive quiz page (Student)  
app.get('/join-competitive', requireAuth, requireRole(['student']), (req, res) => {
  res.render('join-competitive-quiz', { user: req.user });
});

// Competitive quiz taking page
app.get('/competitive-quiz/:sessionId', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const QuizSession = require('./models/QuizSession');
    const session = await QuizSession.findById(req.params.sessionId).populate('quiz');
    
    if (!session) {
      return res.status(404).render('error', { message: 'Session not found' });
    }
    
    // Check if student is part of the session
    const participant = session.participants.find(
      p => p.student.toString() === req.user._id.toString()
    );
    
    if (!participant) {
      return res.status(403).render('error', { message: 'You are not part of this session' });
    }
    
    // Check if student has already completed this session
    if (participant.status === 'completed') {
      return res.status(403).render('error', { 
        message: 'You have already completed this quiz session. Each session can only be taken once.' 
      });
    }
    
    if (session.status !== 'in-progress') {
      return res.status(400).render('error', { message: 'Session is not active' });
    }
    
    // Mark participant as started if not already
    if (participant.status === 'waiting') {
      participant.status = 'in-progress';
      participant.startedAt = new Date();
      await session.save();
    }
    
    res.render('take-competitive-quiz', { 
      quiz: session.quiz,
      session: session,
      sessionId: session._id,
      user: req.user,
      settings: session.settings
    });
  } catch (error) {
    console.error('Error loading competitive quiz:', error);
    res.status(500).render('error', { message: 'Error loading quiz' });
  }
});

// Role-specific dashboards
app.get('/teacher/dashboard', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    // Get selected grade and pagination parameters
    const selectedGrade = req.query.grade || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Build query based on selected grade
    let query = { createdBy: req.user._id };
    if (selectedGrade !== 'all') {
      query.gradeLevel = selectedGrade;
    }
    
    // Get total count for pagination
    const totalQuizzes = await Quiz.countDocuments(query);
    
    // Get paginated quizzes
    const teacherQuizzes = await Quiz.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    // Calculate pagination info
    const totalPages = Math.ceil(totalQuizzes / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    
    // Get quiz counts by grade for tabs
    const gradeCounts = await Quiz.aggregate([
      { $match: { createdBy: req.user._id } },
      { $group: { _id: '$gradeLevel', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    
    // Create grade tabs data with counts
    const gradeTabs = [
      { grade: 'all', label: 'All Grades', count: totalQuizzes },
      { grade: '1st grade', label: '1st Grade', count: 0 },
      { grade: '2nd grade', label: '2nd Grade', count: 0 },
      { grade: '3rd grade', label: '3rd Grade', count: 0 },
      { grade: '4th grade', label: '4th Grade', count: 0 },
      { grade: '5th grade', label: '5th Grade', count: 0 },
      { grade: '6th grade', label: '6th Grade', count: 0 },
      { grade: '7th grade', label: '7th Grade', count: 0 },
      { grade: '8th grade', label: '8th Grade', count: 0 },
      { grade: '9th grade', label: '9th Grade', count: 0 },
      { grade: '10th grade', label: '10th Grade', count: 0 },
      { grade: '11th grade', label: '11th Grade', count: 0 },
      { grade: '12th grade', label: '12th Grade', count: 0 }
    ];
    
    // Update counts from aggregation results
    gradeCounts.forEach(gradeCount => {
      const tab = gradeTabs.find(tab => tab.grade === gradeCount._id);
      if (tab) {
        tab.count = gradeCount.count;
      }
    });
    
    // Get organization information for the teacher
    let organization = null;
    if (req.user.organizationId) {
      organization = await Organization.findById(req.user.organizationId);
    }
    
    res.render('teacher-dashboard', { 
      user: req.user, 
      quizzes: teacherQuizzes,
      organization: organization,
      selectedGrade: selectedGrade,
      gradeTabs: gradeTabs,
              pagination: {
          currentPage: page,
          totalPages,
          totalQuizzes,
          limit,
          hasNextPage,
          hasPrevPage,
          nextPage: hasNextPage ? page + 1 : null,
          prevPage: hasPrevPage ? page - 1 : null
        }
    });
  } catch (error) {
    console.error('Error fetching teacher dashboard data:', error);
    res.render('teacher-dashboard', { 
      user: req.user, 
      quizzes: [],
      organization: null,
      selectedGrade: 'all',
      gradeTabs: [],
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalQuizzes: 0,
        limit: 10,
        hasNextPage: false,
        hasPrevPage: false,
        nextPage: null,
        prevPage: null
      }
    });
  }
});





// Route for student study material page
app.get('/student/study-material', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    // Get all organization IDs the student belongs to
    let organizationIds = [];
    
    if (req.user.organizationMemberships && req.user.organizationMemberships.length > 0) {
      // Multi-organization student - get content from all organizations
      organizationIds = req.user.organizationMemberships.map(membership => membership.organizationId);
      console.log(`Multi-org student: ${req.user.email} accessing study material from ${organizationIds.length} organizations`);
    } else if (req.user.organizationId) {
      // Single organization student - legacy support
      organizationIds = [req.user.organizationId];
      console.log(`Single-org student: ${req.user.email} accessing study material from 1 organization`);
    }
    
    // Get approved content filtered by student's grade level and organizations
    let query = { 
      isApproved: true,
      organizationId: { $in: organizationIds }
    };
    let messageForStudent = null;
    
    // Filter by student's grade level if it exists
    if (req.user.gradeLevel) {
      query.gradeLevel = req.user.gradeLevel;
      console.log(`🎓 Filtering content for student ${req.user.displayName} (${req.user.gradeLevel}) from ${organizationIds.length} organization(s)`);
      console.log(`📋 Query: ${JSON.stringify(query)}`);
    } else {
      console.log(`⚠️  Student ${req.user.displayName} has no grade level set - showing all content from ${organizationIds.length} organization(s)`);
      messageForStudent = "Your grade level is not set. Please ask your teacher to assign you to the correct grade, or update your profile.";
    }
    
    const studyMaterial = await Content.find(query)
      .populate('createdBy', 'displayName')
      .populate('organizationId', 'name')
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
    
    // Get organization details for display
    const organizations = await Organization.find({ 
      _id: { $in: organizationIds } 
    }).select('name subdomain');
    
    res.render('student-study-material', {
      user: req.user,
      studyMaterial,
      gradeMessage: messageForStudent,
      organizations: organizations
    });
  } catch (error) {
    console.error('Error fetching study material:', error);
    res.render('student-study-material', {
      user: req.user,
      studyMaterial: [],
      organizations: []
    });
  }
});

// Route for viewing content in browser (increment view count)
app.get('/student/view-content/:contentId', requireAuth, requireRole(['student']), async (req, res) => {
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
app.get('/student/download-content/:contentId', requireAuth, requireRole(['student']), async (req, res) => {
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

// Whiteboard routes
app.use('/api/whiteboard', whiteboardRoutes);

// Whiteboard Dashboard
app.get('/whiteboard/dashboard', requireAuth, requireRole(['teacher']), requireApprovedTeacher, (req, res) => {
  res.render('whiteboard-dashboard', { user: req.user });
});

// Whiteboard Join Page
app.get('/whiteboard/join', requireAuth, (req, res) => {
  res.render('whiteboard-join', { user: req.user });
});

// Direct join with session ID
app.get('/whiteboard/join/:sessionId', requireAuth, (req, res) => {
  res.render('whiteboard-join', {
    user: req.user,
    sessionId: req.params.sessionId
  });
});

app.get('/student/dashboard', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    console.log(`\n=== STUDENT DASHBOARD DEBUG for ${req.user.email} ===`);
    console.log('User organizationId:', req.user.organizationId);
    console.log('User organizationMemberships:', req.user.organizationMemberships);
    
    // Check if there are multiple accounts for this email
    const allUserAccounts = await User.find({ email: req.user.email });
    console.log(`Found ${allUserAccounts.length} user accounts with email ${req.user.email}`);
    allUserAccounts.forEach((account, index) => {
      console.log(`Account ${index + 1}: googleId=${account.googleId}, orgId=${account.organizationId}, role=${account.role}`);
    });
    
    // Get all organization IDs the student belongs to
    let organizationIds = [];
    
    if (req.user.organizationMemberships && req.user.organizationMemberships.length > 0) {
      // Multi-organization student - get quizzes from all organizations
      organizationIds = req.user.organizationMemberships.map(membership => membership.organizationId);
      console.log(`Multi-org student: ${req.user.email} has access to ${organizationIds.length} organizations`);
    } else if (req.user.organizationId) {
      // Single organization student - legacy support
      organizationIds = [req.user.organizationId];
      console.log(`Single-org student: ${req.user.email} has access to 1 organization`);
      
      // Check if there are other accounts for this user that should be merged
      if (allUserAccounts.length > 1) {
        console.log(`WARNING: Found ${allUserAccounts.length} accounts but user has no organizationMemberships array!`);
        const otherOrgIds = allUserAccounts
          .filter(account => account._id.toString() !== req.user._id.toString())
          .map(account => account.organizationId)
          .filter(orgId => orgId);
        
        if (otherOrgIds.length > 0) {
          console.log(`Adding ${otherOrgIds.length} additional organization IDs from other accounts`);
          organizationIds = organizationIds.concat(otherOrgIds);
        }
      }
    } else {
      console.log(`Student ${req.user.email} has no organization access!`);
    }
    
    // Get quizzes from all student's organizations (excluding competitive quizzes)
    let quizQuery = { 
      isApproved: true,
      organizationId: { $in: organizationIds },
      $or: [
        { quizType: { $ne: 'competitive' } },  // Exclude competitive quizzes
        { quizType: { $exists: false } }       // Include old quizzes without quizType field
      ]
    };
    
    // Filter by student's grade level if it exists
    if (req.user.gradeLevel) {
      quizQuery.gradeLevel = req.user.gradeLevel;
      console.log(`🎓 Filtering quizzes for student ${req.user.displayName} (${req.user.gradeLevel})`);
    } else {
      console.log(`⚠️  Student ${req.user.displayName} has no grade level set - showing all quizzes`);
    }
    
    const availableQuizzes = await Quiz.find(quizQuery)
      .populate('createdBy', 'displayName')
      .populate('organizationId', 'name')
      .sort({ createdAt: -1 });
    
    // Fetch student's quiz results from all their organizations
    const quizResults = await QuizResult.find({
      student: req.user._id,
      organizationId: { $in: organizationIds }
    }).populate('quiz', 'title');

    // Get complex quiz results for dashboard display
    // Filter out results where the quiz has been deleted (quiz is null)
    const allComplexQuizResults = quizResults.filter(result => result.isComplexQuiz);
    const orphanedResults = allComplexQuizResults.filter(result => !result.quiz);

    // Log orphaned results for debugging
    if (orphanedResults.length > 0) {
      console.log(`Found ${orphanedResults.length} orphaned quiz results for student ${req.user.email}`);
      // Optionally clean up orphaned results (uncomment if needed)
      // await QuizResult.deleteMany({ _id: { $in: orphanedResults.map(r => r._id) } });
    }

    const complexQuizResults = allComplexQuizResults.filter(result => result.quiz);
    const pendingComplexQuizzes = complexQuizResults.filter(result => result.gradingStatus === 'pending');
    const gradedComplexQuizzes = complexQuizResults.filter(result => result.gradingStatus === 'graded');

    // Calculate completed count excluding archived quizzes (attemptNumber > 1)
    const completedCount = quizResults.filter(result => result.attemptNumber <= 1).length;

    // Calculate average score excluding archived quizzes
    let averageScore = 0;
    if (completedCount > 0) {
      const nonArchivedResults = quizResults.filter(result => result.attemptNumber <= 1);
      const totalScore = nonArchivedResults.reduce((sum, result) => sum + result.percentage, 0);
      averageScore = Math.round(totalScore / completedCount);
    }
    
    // Get organization details for display
    const organizations = await Organization.find({ 
      _id: { $in: organizationIds } 
    }).select('name subdomain');
    
    console.log(`Student dashboard: Found ${availableQuizzes.length} quizzes from ${organizations.length} organizations`);
    console.log(`Organization IDs used: ${organizationIds.join(', ')}`);
    console.log(`=== END STUDENT DASHBOARD DEBUG ===\n`);
    
    res.render('student-dashboard', {
      user: req.user,
      quizzes: availableQuizzes,
      completedCount,
      averageScore,
      organizations: organizations,
      pendingComplexQuizzes: pendingComplexQuizzes,
      gradedComplexQuizzes: gradedComplexQuizzes,
      needsMigration: allUserAccounts.length > 1 && (!req.user.organizationMemberships || req.user.organizationMemberships.length === 0)
    });
  } catch (error) {
    console.error('Error fetching student dashboard data:', error);
    res.render('student-dashboard', { 
      user: req.user, 
      quizzes: [],
      completedCount: 0,
      averageScore: 0,
      organizations: [],
      needsMigration: false
    });
  }
});

// Migration API for existing multi-org students
app.post('/api/migrate-multi-org-account', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    console.log(`\n=== MIGRATION REQUEST for ${req.user.email} ===`);
    
    // Find all user accounts with the same email
    const allUserAccounts = await User.find({ email: req.user.email });
    console.log(`Found ${allUserAccounts.length} accounts for ${req.user.email}`);
    
    if (allUserAccounts.length <= 1) {
      return res.json({ 
        success: false, 
        message: 'No multiple accounts found to migrate' 
      });
    }
    
    // Use the current authenticated user as the primary account
    const primaryUser = req.user;
    const otherAccounts = allUserAccounts.filter(account => 
      account._id.toString() !== primaryUser._id.toString()
    );
    
    console.log(`Primary account: ${primaryUser._id}, Other accounts: ${otherAccounts.length}`);
    
    // Create organizationMemberships array from all accounts
    const organizationMemberships = [];
    
    // Add primary user's organization
    if (primaryUser.organizationId) {
      organizationMemberships.push({
        organizationId: primaryUser.organizationId,
        role: primaryUser.organizationRole || 'student',
        gradeLevel: primaryUser.gradeLevel,
        subjects: primaryUser.subjects,
        joinedAt: primaryUser.createdAt || new Date(),
        isActive: true
      });
    }
    
    // Add other accounts' organizations
    otherAccounts.forEach(account => {
      if (account.organizationId) {
        organizationMemberships.push({
          organizationId: account.organizationId,
          role: account.organizationRole || 'student',
          gradeLevel: account.gradeLevel,
          subjects: account.subjects,
          joinedAt: account.createdAt || new Date(),
          isActive: true
        });
      }
    });
    
    // Update primary user with organization memberships
    primaryUser.organizationMemberships = organizationMemberships;
    await primaryUser.save();
    
    // Delete the duplicate accounts
    const duplicateIds = otherAccounts.map(account => account._id);
    await User.deleteMany({ _id: { $in: duplicateIds } });
    
    console.log(`Migration completed: ${organizationMemberships.length} organizations merged, ${duplicateIds.length} duplicate accounts removed`);
    
    res.json({
      success: true,
      message: `Successfully merged ${organizationMemberships.length} organization memberships`,
      organizationCount: organizationMemberships.length
    });
    
  } catch (error) {
    console.error('Error during account migration:', error);
    res.status(500).json({
      success: false,
      message: 'Error during account migration'
    });
  }
});

app.get('/admin/dashboard', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
  try {
    const pendingTeachers = await User.find({ role: 'teacher', isApproved: false });
    const pendingQuizzes = [];  // No pending quizzes since all are auto-approved
    res.render('admin-dashboard', { user: req.user, pendingTeachers, pendingQuizzes });
  } catch (error) {
    console.error('Error fetching admin data:', error);
    res.render('admin-dashboard', { user: req.user, pendingTeachers: [], pendingQuizzes: [] });
  }
});



// Quiz management routes
app.get('/create-quiz', requireAuth, requireRole(['teacher']), requireApprovedTeacher, (req, res) => {
  res.render('create-quiz', { user: req.user });
});

// Complex Quiz Builder route
app.get('/create-complex-quiz', requireAuth, requireRole(['teacher']), requireApprovedTeacher, (req, res) => {
  res.render('create-complex-quiz', { user: req.user });
});

// Save complex quiz route
app.post('/create-complex-quiz', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  console.log('=== COMPLEX QUIZ CREATION START ===');

  try {
    console.log('Request body keys:', Object.keys(req.body || {}));
    console.log('User info:', {
      id: req.user?._id,
      name: req.user?.displayName,
      orgId: req.user?.organizationId
    });

    if (!req.body) {
      console.log('ERROR: No request body provided');
      return res.status(400).json({
        success: false,
        message: 'No request body provided'
      });
    }

    const title = req.body.title;
    const description = req.body.description;
    const gradeLevel = req.body.gradeLevel;
    const subject = req.body.subject;
    const quizType = req.body.quizType;
    const elements = req.body.elements;

    console.log('Extracted data:', {
      title: title,
      gradeLevel: gradeLevel,
      subject: subject,
      elementsCount: elements ? elements.length : 0
    });

    // Validate required fields
    if (!title || !gradeLevel || !subject || !elements || elements.length === 0) {
      console.log('ERROR: Missing required fields:', {
        hasTitle: !!title,
        hasGradeLevel: !!gradeLevel,
        hasSubject: !!subject,
        hasElements: !!elements,
        elementsLength: elements ? elements.length : 0
      });
      return res.status(400).json({
        success: false,
        message: 'Missing required fields or no elements provided'
      });
    }

    console.log('Validation passed - proceeding with quiz creation');



    // Append current date and time to the title
    const now = new Date();
    const dateTimeString = now.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).replace(/,/g, '');

    const finalTitle = title + ' - ' + dateTimeString;

    // Function to sanitize content
    function sanitizeContent(content) {
      if (!content) return '';

      // Convert to string
      let sanitized = String(content);

      // Special handling for image data URLs - don't truncate them
      if (sanitized.startsWith('data:image/')) {
        // Validate data URL format
        if (sanitized.includes(',') && sanitized.match(/^data:image\/(jpeg|jpg|png|gif|webp);base64,/)) {
          console.log('Processing image data URL, length:', sanitized.length);
          return sanitized; // Return full data URL without truncation
        } else {
          console.warn('Invalid image data URL detected, removing');
          return ''; // Remove invalid data URLs
        }
      }

      // For non-image content, apply normal sanitization
      // Remove excessive whitespace and newlines
      sanitized = sanitized.replace(/\s+/g, ' ').trim();

      // Limit content length to prevent database issues (only for text content)
      if (sanitized.length > 10000) {
        sanitized = sanitized.substring(0, 10000) + '...';
      }

      return sanitized;
    }

    // Process elements to ensure proper data types
    console.log('Starting element processing...');

    const processedElements = elements.map((element, index) => {
      console.log(`Processing element ${index + 1}:`, {
        id: element.id,
        type: element.type,
        contentLength: element.content ? element.content.length : 0
      });

      try {
        const processed = {
          id: String(element.id || ''),
          type: String(element.type || ''),
          x: Number(element.x) || 0,
          y: Number(element.y) || 0,
          width: Number(element.width) || 200,
          height: Number(element.height) || 100,
          content: sanitizeContent(element.content),
          style: element.style || {}
        };

        console.log(`Element ${index + 1} processed successfully`);
        return processed;
      } catch (error) {
        console.error(`Error processing element ${element.id}:`, error);
        // Return a safe default element
        return {
          id: String(element.id || `element-${index}`),
          type: String(element.type || 'textbox'),
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          content: 'Error processing content',
          style: {}
        };
      }
    });

    console.log('Element processing completed. Processed count:', processedElements.length);

    console.log('Processed elements count:', processedElements.length);

    // Prepare complex quiz data for MongoDB storage
    const complexQuizData = {
      elements: processedElements,
      canvasSize: { width: 1000, height: 800 }
    };

    // Convert elements to questions format for MongoDB
    const questions = [];
    let questionCounter = 1;

    processedElements.forEach(element => {
      if (element.type === 'question' || element.type === 'sub-question') {
        // Clean the content for question text
        let questionText = element.content || 'Question ' + questionCounter;

        // Strip HTML tags for question text but keep basic formatting
        questionText = questionText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

        if (questionText.length > 500) {
          questionText = questionText.substring(0, 500) + '...';
        }

        questions.push({
          question: questionText,
          type: 'short-answer',
          options: [],
          correctAnswer: '',
          points: 1,
          isTextAnswer: true
        });
        questionCounter++;
      }
    });

    // If no questions found, create a default one
    if (questions.length === 0) {
      questions.push({
        question: 'Complex Quiz Question',
        type: 'short-answer',
        options: [],
        correctAnswer: '',
        points: 1,
        isTextAnswer: true
      });
    }

    // Create quiz object with complex data
    console.log('Creating quiz object...');

    const quizData = {
      title: finalTitle,
      description: description || 'Complex quiz created with drag-and-drop builder',
      questions: questions,
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      organizationId: req.user.organizationId,
      gradeLevel: gradeLevel,
      subjects: [subject],
      language: 'English',
      quizType: quizType || 'regular',
      isApproved: true,
      isComplexQuiz: true,
      complexQuizData: complexQuizData
    };

    console.log('Quiz data prepared:', {
      title: quizData.title,
      questionsCount: quizData.questions.length,
      elementsCount: complexQuizData.elements.length,
      hasComplexData: !!quizData.complexQuizData
    });

    const quiz = new Quiz(quizData);
    console.log('Quiz object created, attempting to save...');

    // Save quiz to MongoDB
    await quiz.save();
    console.log('Quiz saved successfully with ID:', quiz._id);

    console.log('Quiz saved successfully with ID:', quiz._id);

    res.json({
      success: true,
      message: 'Complex quiz "' + finalTitle + '" created successfully!',
      quizId: quiz._id
    });

  } catch (error) {
    console.error('=== ERROR CREATING COMPLEX QUIZ ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);

    if (error.errors) {
      console.error('Validation errors:');
      Object.keys(error.errors).forEach(key => {
        console.error(`  ${key}:`, error.errors[key].message);
      });
    }

    if (error.code) {
      console.error('Error code:', error.code);
    }

    console.error('=== END ERROR DETAILS ===');

    res.status(500).json({
      success: false,
      message: 'Failed to create complex quiz: ' + error.message,
      errorType: error.constructor.name,
      details: error.errors ? Object.keys(error.errors) : [],
      code: error.code
    });
  }

  console.log('=== COMPLEX QUIZ CREATION END ===');
});

// Get complex quiz data from MongoDB
app.get('/complex-quiz-data/:quizId', requireAuth, async (req, res) => {
  try {
    const quizId = req.params.quizId;

    // Find the quiz
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    if (!quiz.isComplexQuiz || !quiz.complexQuizData) {
      return res.status(400).json({
        success: false,
        message: 'Complex quiz data not available'
      });
    }

    res.json({
      success: true,
      data: quiz.complexQuizData
    });

  } catch (error) {
    console.error('Error retrieving complex quiz data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve complex quiz data: ' + error.message
    });
  }
});

// Route for teachers to view pending complex quiz submissions
app.get('/teacher/complex-quiz-grading', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    // Find all complex quiz results that need manual grading for this teacher's quizzes
    const pendingResults = await QuizResult.find({
      teacherId: req.user._id,
      isComplexQuiz: true,
      needsManualGrading: true,
      $or: [
        { gradingStatus: 'pending' },
        { status: 'pending-recorrection' } // Include recorrection requests
      ]
    })
    .populate('student', 'displayName email')
    .populate('quiz', 'title')
    .sort({ submittedAt: -1 });

    console.log('Found', pendingResults.length, 'pending complex quiz submissions for teacher:', req.user.displayName);

    res.render('teacher-complex-grading', {
      user: req.user,
      pendingResults: pendingResults
    });

  } catch (error) {
    console.error('Error fetching pending complex quiz submissions:', error);
    res.status(500).send('Error loading complex quiz grading page');
  }
});

// Route for teachers to view and grade a specific complex quiz submission
app.get('/teacher/grade-complex-quiz/:resultId', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const result = await QuizResult.findById(req.params.resultId)
      .populate('student', 'displayName email')
      .populate('quiz', 'title complexQuizData');

    if (!result) {
      return res.status(404).send('Quiz result not found');
    }

    // Verify this teacher owns the quiz
    if (result.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).send('Access denied');
    }

    res.render('grade-complex-quiz', {
      user: req.user,
      result: result,
      quiz: result.quiz
    });

  } catch (error) {
    console.error('Error loading complex quiz for grading:', error);
    res.status(500).send('Error loading quiz for grading');
  }
});

// Route to submit complex quiz grading
app.post('/teacher/grade-complex-quiz/:resultId', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const { manualScore, manualPercentage, teacherComments } = req.body;

    const result = await QuizResult.findById(req.params.resultId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Quiz result not found' });
    }

    // Verify this teacher owns the quiz
    if (result.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Update the result with teacher's grading
    result.manualScore = Number(manualScore) || 0;
    result.manualPercentage = Number(manualPercentage) || 0;
    result.teacherComments = teacherComments || '';
    result.gradingStatus = 'graded';
    result.gradedBy = req.user._id;
    result.gradedAt = new Date();
    result.status = 'completed'; // Mark as completed
    result.score = result.manualScore; // Update main score field
    result.percentage = result.manualPercentage; // Update main percentage field

    // Assign badge based on teacher's grading for complex quizzes
    result.assignBadge();

    await result.save();

    console.log('Complex quiz graded by teacher:', req.user.displayName, 'Result ID:', result._id);

    res.json({
      success: true,
      message: 'Complex quiz graded successfully'
    });

  } catch (error) {
    console.error('Error grading complex quiz:', error);
    res.status(500).json({
      success: false,
      message: 'Error grading complex quiz: ' + error.message
    });
  }
});

// Route for students to request complex quiz re-grading
app.post('/request-complex-quiz-recorrection', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const { resultId } = req.body;

    // Find the quiz result
    const result = await QuizResult.findById(resultId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Quiz result not found' });
    }

    // Verify this student owns the result
    if (result.student.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Verify this is a complex quiz that has been graded
    if (!result.isComplexQuiz) {
      return res.status(400).json({ success: false, message: 'This is not a complex quiz' });
    }

    if (result.gradingStatus !== 'graded') {
      return res.status(400).json({ success: false, message: 'This quiz has not been graded yet' });
    }

    if (result.status === 'pending-recorrection') {
      return res.status(400).json({ success: false, message: 'Re-grading request already pending' });
    }

    // Update the result status
    result.status = 'pending-recorrection';
    result.gradingStatus = 'pending'; // Reset to pending for re-grading
    result.recorrectionRequested = true;
    result.recorrectionRequestedAt = new Date();

    await result.save();

    console.log('Complex quiz re-grading requested by student:', req.user.displayName, 'Result ID:', result._id);

    res.json({
      success: true,
      message: 'Re-grading request submitted successfully'
    });

  } catch (error) {
    console.error('Error requesting complex quiz re-grading:', error);
    res.status(500).json({
      success: false,
      message: 'Error requesting re-grading: ' + error.message
    });
  }
});

app.post('/create-quiz', requireAuth, requireRole(['teacher']), requireApprovedTeacher, upload.fields([
  { name: 'questionPaper', maxCount: 1 },
  { name: 'answerPaper', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, description, gradeLevel, subjects, language, quizType } = req.body;
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
    console.log('Description value received:', description);
    console.log('Description type:', typeof description);
    console.log('Description length:', description ? description.length : 'null/undefined');

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
        
        // Note: Image extraction has been removed


        
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
      description: description || `Quiz created from uploaded document on ${new Date().toLocaleDateString()}`,
      gradeLevel,
      subjects: [subjects], // Convert single subject to array for database
      language: language, // Include selected language
      quizType: quizType || 'regular', // Add quiz type with default
      questions: extractedQuestions,
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      organizationId: req.user.organizationId, // Add organization context for SaaS
      isApproved: true,  // Auto-approve teacher quizzes
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

// Manual quiz creation route
app.post('/create-quiz-manual', requireAuth, requireRole(['teacher']), requireApprovedTeacher, quizImageUpload.array('questionImages', 50), async (req, res) => {
  try {
    const { title, description, gradeLevel, subjects, language, quizType, isManuallyCreated } = req.body;
    const questions = JSON.parse(req.body.questions);
    
    // Append current date and time to the title
    const now = new Date();
    const dateTimeString = now.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).replace(/,/g, ''); // Remove commas for cleaner format
    
    const finalTitle = `${title} - ${dateTimeString}`;
    
    console.log('Manual quiz creation:', { originalTitle: title, finalTitle, quizType, questionsCount: questions.length });
    console.log('Uploaded files:', req.files ? req.files.length : 0);
    console.log('Question image indexes:', req.body.questionImageIndexes);
    console.log('Question image indexes type:', typeof req.body.questionImageIndexes);
    console.log('Question image indexes isArray:', Array.isArray(req.body.questionImageIndexes));
    if (req.files) {
      req.files.forEach((file, index) => {
        console.log(`File ${index}:`, file.originalname);
      });
    }
    
    // Validate required fields
    if (!title || !gradeLevel || !subjects) {
      return res.status(400).send('Missing required fields');
    }
    
    if (!questions || questions.length === 0) {
      return res.status(400).send('At least one question is required');
    }
    
    // Process questions and upload images to S3
    console.log('Processing questions and uploading images...');
    const extractedQuestions = [];
    
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`Processing question ${i + 1}:`, q.questionText.substring(0, 50) + '...');
      console.log(`Question ${i + 1} hasImage:`, q.hasImage);
      console.log(`Question ${i + 1} full data:`, JSON.stringify(q, null, 2));
      
      const baseQuestion = {
        question: q.questionText,
        questionNumber: i + 1,
        points: 1
      };
      
      // Handle image upload for this question
      let imageS3Key = null;
      if (q.hasImage && req.files && req.files.length > 0) {
        try {
          // Find the image file for this specific question using the index mapping
          let questionImageIndexes = req.body.questionImageIndexes;
          let imageFile = null;
          
          // Parse questionImageIndexes if it's a JSON string
          if (typeof questionImageIndexes === 'string') {
            try {
              questionImageIndexes = JSON.parse(questionImageIndexes);
            } catch (error) {
              console.error('Error parsing questionImageIndexes:', error);
              questionImageIndexes = [];
            }
          }
          
          if (Array.isArray(questionImageIndexes)) {
            // Find the file that corresponds to this question index
            const fileIndex = questionImageIndexes.findIndex(index => parseInt(index) === i);
            if (fileIndex !== -1 && req.files[fileIndex]) {
              imageFile = req.files[fileIndex];
            }
          } else if (req.files && req.files[i]) {
            // Fallback to old method for backward compatibility
            imageFile = req.files[i];
          }
          
          // Debug logging
          console.log(`Question ${i + 1} - hasImage: ${q.hasImage}, questionImageIndexes:`, questionImageIndexes);
          if (Array.isArray(questionImageIndexes)) {
            const fileIndex = questionImageIndexes.findIndex(index => parseInt(index) === i);
            console.log(`Question ${i + 1} - fileIndex found: ${fileIndex}, imageFile:`, imageFile ? imageFile.originalname : 'null');
          }
          
          if (imageFile) {
            console.log(`Uploading image for question ${i + 1}:`, imageFile.originalname);
            imageS3Key = await uploadToS3(imageFile, 'question-images');
            console.log(`Image uploaded successfully to S3: ${imageS3Key}`);
          } else {
            console.log(`No image file found for question ${i + 1}`);
          }
        } catch (error) {
          console.error(`Error uploading image for question ${i + 1}:`, error);
          imageS3Key = null;
        }
      }
      
      if (q.answerFormat === 'multiple') {
        // Multiple choice question
        extractedQuestions.push({
          ...baseQuestion,
          options: q.options,
          correctAnswer: q.selectionType === 'single' 
            ? q.options[q.correctAnswers[0]]
            : q.correctAnswers.map(i => q.options[i]).join(','),
          multipleCorrect: q.selectionType === 'multiple',
          image: imageS3Key, // Store S3 key instead of URL
          type: 'multiple-choice'
        });
      } else {
        // Text answer question
        extractedQuestions.push({
          ...baseQuestion,
          options: [],
          correctAnswer: q.expectedAnswer,
          isTextAnswer: true,
          image: imageS3Key, // Store S3 key instead of URL
          type: 'short-answer'
        });
      }
    }
    
    // Create the quiz
    const quiz = new Quiz({
      title: finalTitle,  // Use title with appended date/time
      description: description || 'Manually created quiz',  // Ensure description is never empty
      gradeLevel,
      subjects: [subjects],
      language: language || 'English',
      quizType: quizType || 'regular',
      questions: extractedQuestions,
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      organizationId: req.user.organizationId,
      isApproved: true,  // Auto-approve teacher quizzes
      isManuallyCreated: true,
      questionPaperUrl: null,
      answerPaperUrl: null
    });
    
    await quiz.save();
    console.log('Manual quiz saved successfully with ID:', quiz._id);
    console.log('Quiz saved with title:', finalTitle);
    console.log('Total questions saved:', extractedQuestions.length);
    console.log('Questions with images:', extractedQuestions.filter(q => q.image).length);
    extractedQuestions.forEach((q, index) => {
      if (q.image) {
        console.log(`Question ${index + 1} has image:`, q.image);
      }
    });
    
    res.json({ 
      success: true, 
      quizId: quiz._id,
      finalTitle: finalTitle,  // Send back the final title with date/time
      message: `Quiz created successfully as: ${finalTitle}`
    });
  } catch (error) {
    console.error('Error creating manual quiz:', error);
    
    // Provide more detailed error messages for validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      console.error('Validation errors:', errors);
      return res.status(400).send(`Validation error: ${errors.join(', ')}`);
    }
    
    res.status(500).send('Error creating quiz: ' + error.message);
  }
});



// Recorrection system routes
app.post('/request-recorrection', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const { resultId } = req.body;
    
    // Find the quiz result
    const QuizResult = require('./models/QuizResult');
    const result = await QuizResult.findById(resultId);
    
    if (!result) {
      return res.status(404).json({ error: 'Quiz result not found' });
    }
    
    // Check if student owns this result
    if (result.student.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only request recorrection for your own results' });
    }
    
    // Check if already requested
    if (result.recorrectionRequested) {
      return res.status(400).json({ error: 'Recorrection already requested for this result' });
    }
    
    // Check if result is completed
    if (result.status !== 'completed') {
      return res.status(400).json({ error: 'Only completed results can be sent for recorrection' });
    }
    
    // Check if this is an archived quiz (attemptNumber > 1)
    if (result.attemptNumber > 1) {
      return res.status(400).json({ error: 'Archived quizzes cannot be sent for recorrection' });
    }
    
    // Update the result
    result.recorrectionRequested = true;
    result.recorrectionRequestedAt = new Date();
    result.originalScore = result.score;
    result.originalPercentage = result.percentage;
    result.status = 'pending-recorrection';
    
    await result.save();
    
    res.json({ 
      success: true, 
      message: 'Recorrection request sent successfully' 
    });
    
  } catch (error) {
    console.error('Error requesting recorrection:', error);
    res.status(500).json({ error: 'Error requesting recorrection' });
  }
});

// API endpoint to get recorrection requests for teachers
app.get('/api/recorrection-requests', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const QuizResult = require('./models/QuizResult');
    
    // Get grade filter and pagination parameters
    const selectedGrade = req.query.grade || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Build base query
    let baseQuery = {
      teacherId: req.user._id,
      organizationId: req.user.organizationId,
      status: 'pending-recorrection',
      recorrectionRequested: true
    };
    
    // Get total count for pagination
    let totalRequests;
    if (selectedGrade === 'all') {
      totalRequests = await QuizResult.countDocuments(baseQuery);
    } else {
      // For grade-specific filtering, we need to join with Quiz collection
      totalRequests = await QuizResult.aggregate([
        { $match: baseQuery },
        { $lookup: { from: 'quizzes', localField: 'quiz', foreignField: '_id', as: 'quizData' } },
        { $unwind: '$quizData' },
        { $match: { 'quizData.gradeLevel': selectedGrade } },
        { $count: 'total' }
      ]);
      totalRequests = totalRequests.length > 0 ? totalRequests[0].total : 0;
    }
    
    // Get paginated recorrection requests
    let requests;
    if (selectedGrade === 'all') {
      requests = await QuizResult.find(baseQuery)
        .populate('student', 'displayName email')
        .populate('quiz', 'title gradeLevel')
        .sort({ recorrectionRequestedAt: -1 })
        .skip(skip)
        .limit(limit);
    } else {
      // For grade-specific filtering, use aggregation
      requests = await QuizResult.aggregate([
        { $match: baseQuery },
        { $lookup: { from: 'quizzes', localField: 'quiz', foreignField: '_id', as: 'quizData' } },
        { $unwind: '$quizData' },
        { $match: { 'quizData.gradeLevel': selectedGrade } },
        { $sort: { recorrectionRequestedAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $lookup: { from: 'users', localField: 'student', foreignField: '_id', as: 'studentData' } },
        { $unwind: '$studentData' },
        { $project: {
          _id: 1,
          score: 1,
          percentage: 1,
          recorrectionRequestedAt: 1,
          student: '$studentData',
          quiz: '$quizData'
        }}
      ]);
    }
    
    // Calculate pagination info
    const totalPages = Math.ceil(totalRequests / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    
    res.json({
      requests,
      pagination: {
        currentPage: page,
        totalPages,
        totalRequests,
        limit,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      }
    });
    
  } catch (error) {
    console.error('Error fetching recorrection requests:', error);
    res.status(500).json({ error: 'Error fetching recorrection requests' });
  }
});

// API endpoint to get recorrection request counts by grade
app.get('/api/recorrection-grade-counts', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const QuizResult = require('./models/QuizResult');
    
    // Get recorrection request counts by grade
    const gradeCounts = await QuizResult.aggregate([
      { $match: {
        teacherId: req.user._id,
        organizationId: req.user.organizationId,
        status: 'pending-recorrection',
        recorrectionRequested: true
      }},
      { $lookup: { from: 'quizzes', localField: 'quiz', foreignField: '_id', as: 'quizData' } },
      { $unwind: '$quizData' },
      { $group: { _id: '$quizData.gradeLevel', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    
    // Create grade tabs data with counts
    const gradeTabs = [
      { grade: 'all', label: 'All Grades', count: 0 },
      { grade: '1st grade', label: '1st Grade', count: 0 },
      { grade: '2nd grade', label: '2nd Grade', count: 0 },
      { grade: '3rd grade', label: '3rd Grade', count: 0 },
      { grade: '4th grade', label: '4th Grade', count: 0 },
      { grade: '5th grade', label: '5th Grade', count: 0 },
      { grade: '6th grade', label: '6th Grade', count: 0 },
      { grade: '7th grade', label: '7th Grade', count: 0 },
      { grade: '8th grade', label: '8th Grade', count: 0 },
      { grade: '9th grade', label: '9th Grade', count: 0 },
      { grade: '10th grade', label: '10th Grade', count: 0 },
      { grade: '11th grade', label: '11th Grade', count: 0 },
      { grade: '12th grade', label: '12th Grade', count: 0 }
    ];
    
    // Update counts from aggregation results
    gradeCounts.forEach(gradeCount => {
      const tab = gradeTabs.find(tab => tab.grade === gradeCount._id);
      if (tab) {
        tab.count = gradeCount.count;
      }
    });
    
    // Calculate total count for "All Grades" tab
    const totalCount = gradeCounts.reduce((sum, gradeCount) => sum + gradeCount.count, 0);
    gradeTabs[0].count = totalCount;
    
    res.json({ gradeTabs });
    
  } catch (error) {
    console.error('Error fetching recorrection grade counts:', error);
    res.status(500).json({ error: 'Error fetching grade counts' });
  }
});

// Route to view recorrection details
app.get('/recorrection-details/:resultId', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const QuizResult = require('./models/QuizResult');
    const result = await QuizResult.findById(req.params.resultId)
      .populate('student', 'displayName email')
      .populate('quiz', 'title questions');
    
    if (!result) {
      return res.status(404).render('error', { message: 'Result not found' });
    }
    
    // Check if teacher owns this quiz
    if (result.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).render('error', { message: 'You can only view results for your own quizzes' });
    }
    
    res.render('recorrection-details', { result });
    
  } catch (error) {
    console.error('Error viewing recorrection details:', error);
    res.status(500).render('error', { message: 'Error viewing recorrection details' });
  }
});

// Route to process recorrection
app.get('/process-recorrection/:resultId', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const QuizResult = require('./models/QuizResult');
    const result = await QuizResult.findById(req.params.resultId)
      .populate('student', 'displayName email')
      .populate('quiz', 'title questions');
    
    if (!result) {
      return res.status(404).render('error', { message: 'Result not found' });
    }
    
    // Check if teacher owns this quiz
    if (result.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).render('error', { message: 'You can only process results for your own quizzes' });
    }
    
    res.render('process-recorrection', { result });
    
  } catch (error) {
    console.error('Error processing recorrection:', error);
    res.status(500).render('error', { message: 'Error processing recorrection' });
  }
});

// Route to save recorrection
app.post('/save-recorrection', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const { resultId, newScore, feedback } = req.body;
    
    const QuizResult = require('./models/QuizResult');
    const result = await QuizResult.findById(resultId);
    
    if (!result) {
      return res.status(404).json({ error: 'Result not found' });
    }
    
    // Check if teacher owns this quiz
    if (result.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only process results for your own quizzes' });
    }
    
    // Update the result
    result.score = parseInt(newScore);
    result.percentage = Math.round((result.score / result.totalPoints) * 100);
    result.teacherFeedback = feedback || '';
    result.status = 'rechecked';
    result.recorrectionCompletedAt = new Date();
    result.recorrectionCompletedBy = req.user._id;
    
    // Recalculate correct answers based on new score
    // This is a simplified approach - in a real system you might want to re-evaluate individual answers
    result.correctAnswers = Math.round((result.score / result.totalPoints) * result.totalQuestions);
    
    await result.save();
    
    res.json({ 
      success: true, 
      message: 'Recorrection completed successfully',
      newScore: result.score,
      newPercentage: result.percentage
    });
    
  } catch (error) {
    console.error('Error saving recorrection:', error);
    res.status(500).json({ error: 'Error saving recorrection' });
  }
});

// Route to check current user status
app.get('/check-user', requireAuth, async (req, res) => {
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
app.get('/quiz-results/:quizId', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
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
app.get('/teacher/post-content', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
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
app.post('/teacher/post-content', requireAuth, requireRole(['teacher']), requireApprovedTeacher, upload.single('contentFile'), async (req, res) => {
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
      organizationId: req.user.organizationId, // Add organization context for SaaS
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
app.post('/admin/approve-all-content', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
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
app.get('/teacher/test-assign', requireAuth, requireRole(['teacher']), (req, res) => {
  res.send(`<h1>Test Route Works!</h1><p>User: ${req.user.displayName}</p><p>Role: ${req.user.role}</p>`);
});

// Route for teacher assign students page
app.get('/teacher/assign-students', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
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
app.post('/teacher/assign-students', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
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
app.post('/teacher/unassign-students', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
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
app.post('/admin/approve-all-teacher-content', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
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
app.get('/admin/content-by-grade', requireAuth, requireRole(['admin', 'teacher']), async (req, res) => {
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
app.delete('/admin/delete-content/:contentId', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
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
app.post('/admin/approve-content/:contentId', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
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
app.delete('/teacher/delete-content/:contentId', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
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
app.get('/admin/content-management', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
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
app.get('/teacher/student-results', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    // Get all quizzes created by this teacher
    const teacherQuizzes = await Quiz.find({ createdBy: req.user._id });
    const quizIds = teacherQuizzes.map(quiz => quiz._id);
    
    // Fetch all student results for teacher's quizzes in their organization
    const allResults = await QuizResult.find({ 
      quiz: { $in: quizIds },
      organizationId: req.user.organizationId // Filter by organization for SaaS
    })
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
app.get('/view-files/:quizId', requireAuth, async (req, res) => {
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
app.delete('/delete-quiz/:quizId', requireAuth, requireRole(['teacher']), async (req, res) => {
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
app.post('/update-student-profile', requireAuth, requireRole(['student']), async (req, res) => {
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
app.get('/student-profile', requireAuth, requireRole(['student']), async (req, res) => {
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
app.get('/available-quizzes', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    console.log(`\n=== AVAILABLE QUIZZES DEBUG for ${req.user.email} ===`);
    
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const skip = (page - 1) * limit;
    const tab = req.query.tab || 'available'; // 'available' or 'archived'
    
    // Get all organization IDs the student belongs to
    let organizationIds = [];
    
    if (req.user.organizationMemberships && req.user.organizationMemberships.length > 0) {
      // Multi-organization student - get quizzes from all organizations
      organizationIds = req.user.organizationMemberships.map(membership => membership.organizationId);
      console.log(`Multi-org student: ${req.user.email} browsing quizzes from ${organizationIds.length} organizations`);
    } else if (req.user.organizationId) {
      // Single organization student - legacy support
      organizationIds = [req.user.organizationId];
      console.log(`Single-org student: ${req.user.email} browsing quizzes from 1 organization`);
      
      // Check if there are other accounts for this user that should be included
      const allUserAccounts = await User.find({ email: req.user.email });
      if (allUserAccounts.length > 1) {
        console.log(`Found ${allUserAccounts.length} accounts for ${req.user.email} - including all organizations`);
        const otherOrgIds = allUserAccounts
          .filter(account => account._id.toString() !== req.user._id.toString())
          .map(account => account.organizationId)
          .filter(orgId => orgId);
        
        if (otherOrgIds.length > 0) {
          console.log(`Adding ${otherOrgIds.length} additional organization IDs from other accounts`);
          organizationIds = organizationIds.concat(otherOrgIds);
        }
      }
    } else {
      console.log(`Student ${req.user.email} has no organization access!`);
    }
    
    // Build filter for ALL organizations
    // Exclude competitive quizzes - they should only be accessed through sessions
    let filter = { 
      isApproved: true,
      organizationId: { $in: organizationIds },
      $or: [
        { quizType: { $ne: 'competitive' } },  // Exclude competitive quizzes
        { quizType: { $exists: false } }       // Include old quizzes without quizType field
      ]
    };
    
    // Filter by student's grade level if it exists
    if (req.user.gradeLevel) {
      filter.gradeLevel = req.user.gradeLevel;
      console.log(`🎓 Filtering quizzes for student ${req.user.displayName} (${req.user.gradeLevel})`);
    } else {
      console.log(`⚠️  Student ${req.user.displayName} has no grade level set - showing all quizzes`);
    }
    
    console.log('Quiz filter (all organizations, excluding competitive):', filter);
    
    const allQuizzes = await Quiz.find(filter)
      .populate('createdBy', 'displayName')
      .populate('organizationId', 'name')
      .sort({ createdAt: -1 });
    
    console.log('Found quizzes from all organizations:', allQuizzes.length);
    console.log('Quiz breakdown by organization:');
    const quizByOrg = {};
    allQuizzes.forEach(quiz => {
      const orgName = quiz.organizationId?.name || 'Unknown';
      if (!quizByOrg[orgName]) quizByOrg[orgName] = 0;
      quizByOrg[orgName]++;
    });
    console.log(quizByOrg);
    
    // Get the student's quiz results from all organizations
    const studentResults = await QuizResult.find({ 
      student: req.user._id,
      organizationId: { $in: organizationIds }
    }).select('quiz score percentage timeTaken createdAt attemptNumber');
    
    // Create a map of quiz IDs and their attempt counts
    const quizAttempts = {};
    studentResults.forEach(result => {
      const quizId = result.quiz.toString();
      if (!quizAttempts[quizId]) {
        quizAttempts[quizId] = {
          count: 0,
          maxAttemptNumber: 0
        };
      }
      quizAttempts[quizId].count++;
      quizAttempts[quizId].maxAttemptNumber = Math.max(quizAttempts[quizId].maxAttemptNumber, result.attemptNumber || 1);
    });
    
    // Separate available and archived quizzes
    const availableQuizzes = [];
    const archivedQuizzes = [];
    
    allQuizzes.forEach(quiz => {
      const quizId = quiz._id.toString();
      const attemptData = quizAttempts[quizId] || { count: 0, maxAttemptNumber: 0 };
      const attemptCount = attemptData.count;
      const isTaken = attemptCount > 0;
      const canRetake = attemptCount < 3;
      const previousResult = isTaken ? studentResults.find(result => result.quiz.toString() === quizId) : null;
      
      const quizData = {
        ...quiz.toObject(),
        createdByName: quiz.createdBy ? quiz.createdBy.displayName : 'Teacher',
        organizationName: quiz.organizationId ? quiz.organizationId.name : 'Organization',
        isTaken: isTaken,
        attemptCount: attemptCount,
        canRetake: canRetake,
        previousScore: previousResult ? previousResult.percentage : null,
        previousTime: previousResult ? previousResult.timeTaken : null
      };
      
      if (isTaken) {
        archivedQuizzes.push(quizData);
      } else {
        availableQuizzes.push(quizData);
      }
    });
    
    // Get quizzes for the selected tab
    const quizzesToShow = tab === 'archived' ? archivedQuizzes : availableQuizzes;
    const totalQuizzes = quizzesToShow.length;
    const totalPages = Math.ceil(totalQuizzes / limit);
    
    // Apply pagination
    const paginatedQuizzes = quizzesToShow.slice(skip, skip + limit);
    
    res.render('available-quizzes', { 
      quizzes: paginatedQuizzes,
      user: req.user,
      currentTab: tab,
      pagination: {
        currentPage: page,
        totalPages,
        totalQuizzes,
        limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        nextPage: page < totalPages ? page + 1 : null,
        prevPage: page > 1 ? page - 1 : null
      },
      counts: {
        available: availableQuizzes.length,
        archived: archivedQuizzes.length
      }
    });
    
    console.log(`=== END AVAILABLE QUIZZES DEBUG ===\n`);
  } catch (error) {
    console.error('Error fetching available quizzes:', error);
    res.status(500).send('Error fetching quizzes');
  }
});

// Debug route to check quiz data structure
app.get('/debug-quiz/:quizId', requireAuth, requireRole(['teacher']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    
    res.json({
      quizId: quiz._id,
      title: quiz.title,
      questions: quiz.questions.map((q, index) => ({
        questionNumber: index + 1,
        question: q.question.substring(0, 100) + '...',
        hasImage: !!q.image,
        imageUrl: q.image,
        imageField: q.image,
        allFields: Object.keys(q),
        fullQuestion: q
      }))
    });
  } catch (error) {
    console.error('Error debugging quiz:', error);
    res.status(500).json({ error: 'Error debugging quiz' });
  }
});

// Debug route to check quiz data structure (accessible by students)
app.get('/debug-quiz-student/:quizId', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    
    res.json({
      quizId: quiz._id,
      title: quiz.title,
      questions: quiz.questions.map((q, index) => ({
        questionNumber: index + 1,
        question: q.question.substring(0, 100) + '...',
        hasImage: !!q.image,
        imageUrl: q.image,
        imageField: q.image,
        allFields: Object.keys(q),
        fullQuestion: q
      }))
    });
  } catch (error) {
    console.error('Error debugging quiz:', error);
    res.status(500).json({ error: 'Error debugging quiz' });
  }
});

// Route to create podcast page
app.get('/create-podcast', requireAuth, requireRole(['teacher']), requireApprovedTeacher, (req, res) => {
  res.render('create-podcast', { user: req.user });
});

// Route to start taking a quiz
app.get('/take-quiz/:quizId', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).send('Quiz not found');
    }
    
    // Check if this is a competitive quiz - those must be accessed through sessions
    if (quiz.quizType === 'competitive') {
      return res.status(403).render('error', { 
        message: 'This is a competitive quiz. Please join through a session code provided by your teacher.' 
      });
    }
    
    // No need to check approval since all quizzes are auto-approved
    // if (!quiz.isApproved) {
    //   return res.status(403).send('This quiz is not yet approved');
    // }
    
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
    
    // Debug: Log quiz data to check if images are present
    console.log('=== TAKE QUIZ DEBUG ===');
    console.log('Quiz ID:', quiz._id);
    console.log('Quiz title:', quiz.title);
    console.log('Total questions:', quiz.questions.length);
    console.log('Full quiz object keys:', Object.keys(quiz));
    console.log('Quiz type:', typeof quiz);
    console.log('Quiz is Mongoose document:', quiz.constructor.name);
    
    // Convert to plain object to see what will be sent to frontend
    const quizPlain = quiz.toObject ? quiz.toObject() : quiz;
    console.log('Quiz plain object keys:', Object.keys(quizPlain));


    
    quiz.questions.forEach((q, index) => {
      console.log(`Question ${index + 1}:`, {
        hasImage: !!q.image,
        imageUrl: q.image,
        imageType: typeof q.image,
        imageLength: q.image ? q.image.length : 0,
        questionText: q.question.substring(0, 50) + '...',
        questionKeys: Object.keys(q),
        questionObject: JSON.stringify(q, null, 2)
      });
    });
    console.log('=== END TAKE QUIZ DEBUG ===');
    
    res.render('take-quiz', { 
      quiz, 
      user: req.user,
      s3BucketName: process.env.AWS_BUCKET_NAME 
    });
  } catch (error) {
    console.error('Error starting quiz:', error);
    res.status(500).send('Error starting quiz');
  }
});

// Route to submit quiz answers
app.post('/submit-quiz/:quizId', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }
    
    // Prevent direct submission to competitive quizzes
    if (quiz.quizType === 'competitive') {
      return res.status(403).json({ 
        success: false, 
        message: 'Competitive quizzes must be submitted through a session.' 
      });
    }
    
    const { answers, timeTaken, isComplexQuiz, timeSpent } = req.body;

    // Handle complex quiz submission
    if (isComplexQuiz && quiz.isComplexQuiz) {
      console.log('=== COMPLEX QUIZ SUBMISSION START ===');
      console.log('User:', req.user.displayName, req.user._id);
      console.log('Quiz:', quiz.title, quiz._id);
      console.log('Complex quiz answers:', JSON.stringify(answers, null, 2));

      try {
        // For complex quizzes, convert answers to the expected format
        const formattedAnswers = [];
        const complexAnswersData = answers || {};

        // Convert complex quiz answers to QuizResult format
        Object.keys(complexAnswersData).forEach((elementId, index) => {
          formattedAnswers.push({
            questionIndex: index,
            selectedAnswer: complexAnswersData[elementId] || '',
            isCorrect: false, // Will be determined by teacher
            correctAnswer: 'To be graded by teacher', // Required field - placeholder for complex quizzes
            elementId: elementId // Store the original element ID for reference
          });
        });

        // If no answers, create a placeholder
        if (formattedAnswers.length === 0) {
          formattedAnswers.push({
            questionIndex: 0,
            selectedAnswer: 'No answers provided',
            isCorrect: false,
            correctAnswer: 'To be graded by teacher' // Required field
          });
        }

        const quizResultData = {
          student: req.user._id,
          studentName: req.user.displayName,
          quiz: quiz._id,
          quizTitle: quiz.title,
          organizationId: req.user.organizationId, // Required field
          teacherId: quiz.createdBy, // Required field - quiz creator
          answers: formattedAnswers, // Formatted answers array
          score: 0, // Complex quizzes don't have automatic scoring
          percentage: 0,
          correctAnswers: 0,
          totalQuestions: formattedAnswers.length,
          totalPoints: 0, // Required field - will be set by teacher
          timeTaken: timeSpent || 0,
          submittedAt: new Date(),
          completedAt: new Date(),
          status: 'pending-recorrection', // Use existing status for teacher review
          isComplexQuiz: true,
          needsManualGrading: true, // Flag for teacher review
          gradingStatus: 'pending', // Status for teacher grading workflow
          complexAnswersData: complexAnswersData // Store original complex answers for teacher review
        };

        console.log('Creating quiz result with data:', JSON.stringify(quizResultData, null, 2));

        const quizResult = new QuizResult(quizResultData);
        await quizResult.save();

        console.log('Complex quiz result saved successfully:', quizResult._id);
        console.log('=== COMPLEX QUIZ SUBMISSION END ===');

        return res.json({
          success: true,
          message: 'Complex quiz submitted successfully! Your answers have been sent to your teacher for review.',
          resultId: quizResult._id,
          isComplexQuiz: true,
          needsManualGrading: true
        });

      } catch (error) {
        console.error('=== ERROR SAVING COMPLEX QUIZ RESULT ===');
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);

        if (error.errors) {
          console.error('Validation errors:');
          Object.keys(error.errors).forEach(key => {
            console.error(`  ${key}:`, error.errors[key].message);
          });
        }

        console.error('=== END ERROR DETAILS ===');

        return res.status(500).json({
          success: false,
          message: 'Error saving complex quiz submission: ' + error.message,
          errorType: error.constructor.name
        });
      }
    }

    // Regular quiz processing
    const answersArray = Array.isArray(answers) ? answers : [];

    // Debug: Log received answers
    console.log('Received answers from frontend:', JSON.stringify(answersArray, null, 2));
    
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
      
      // Trim whitespace from both student answer and correct answer for comparison
      const trimmedSelectedAnswer = selectedAnswer.trim();
      const trimmedCorrectAnswer = question.correctAnswer.trim();
      
      // Debug: Log answer extraction and trimming
      console.log(`Question ${index}: received answer object:`, answersArray[index]);
      console.log(`Question ${index}: extracted answer: "${selectedAnswer}"`);
      console.log(`Question ${index}: trimmed student answer: "${trimmedSelectedAnswer}"`);
      console.log(`Question ${index}: trimmed correct answer: "${trimmedCorrectAnswer}"`);
      
      const isCorrect = trimmedSelectedAnswer === trimmedCorrectAnswer;
      
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
    
    // Get attempt number for this quiz
    const existingResults = await QuizResult.find({
      student: req.user._id,
      quiz: quiz._id
    });
    const attemptNumber = existingResults.length + 1;
    
    // Save quiz result
    const quizResult = new QuizResult({
      student: req.user._id,
      studentName: req.user.displayName,
      quiz: quiz._id,
      quizTitle: quiz.title,
      teacherId: quiz.createdBy, // Add teacher reference
      organizationId: req.user.organizationId, // Add organization context for SaaS
      answers: processedAnswers,
      totalQuestions: quiz.questions.length,
      correctAnswers: correctAnswers,
      totalPoints: quiz.questions.reduce((sum, q) => sum + q.points, 0),
      score: score,
      percentage: percentage,
      timeTaken: timeTaken || 0,
      completedAt: new Date(),
      attemptNumber: attemptNumber
    });
    
    // Assign badge based on score (only for first attempts)
    quizResult.assignBadge();
    await quizResult.save();
    
    res.json({ 
      success: true, 
      resultId: quizResult._id,
      score: score,
      percentage: percentage,
      correctAnswers: correctAnswers,
      totalQuestions: quiz.questions.length,
      timeTaken: timeTaken || 0,
      badge: quizResult.badge,
      badgeEarned: quizResult.badgeEarned
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ success: false, message: 'Error submitting quiz' });
  }
});

// Route to view quiz result
app.get('/quiz-result/:resultId', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    console.log('🔍 Quiz result route accessed for resultId:', req.params.resultId);
    console.log('🔍 User ID:', req.user._id);
    console.log('🔍 User role:', req.user.role);
    
    const result = await QuizResult.findById(req.params.resultId)
      .populate('quiz')
      .populate('student');
    
    console.log('🔍 QuizResult lookup result:', result ? 'Found' : 'Not found');
    
    if (!result) {
      console.log('❌ Result not found in database');
      return res.status(404).send('Result not found');
    }
    
    console.log('🔍 Result found, checking ownership...');
    console.log('🔍 Result student ID:', result.student._id);
    console.log('🔍 Current user ID:', req.user._id);
    
    // Check if the student owns this result
    if (result.student._id.toString() !== req.user._id.toString()) {
      console.log('❌ Access denied - student does not own this result');
      return res.status(403).send('Access denied');
    }
    
    console.log('✅ Access granted, rendering quiz result page');
    res.render('quiz-result', { result, user: req.user });
  } catch (error) {
    console.error('❌ Error viewing quiz result:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).send('Error viewing result');
  }
});

// Route to get student badge summary
app.get('/api/student-badges', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const QuizResult = require('./models/QuizResult');
    const badgeSummary = await QuizResult.getStudentBadgeSummary(req.user._id, req.user.organizationId);
    
    res.json({ 
      success: true, 
      badgeSummary 
    });
  } catch (error) {
    console.error('Error getting student badge summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error getting badge summary' 
    });
  }
});

// Debug route to check if a quiz result exists
app.get('/api/debug-quiz-result/:resultId', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    console.log('🔍 Debug route accessed for resultId:', req.params.resultId);
    
    // Check if QuizResult model is available
    console.log('🔍 QuizResult model available:', typeof QuizResult);
    
    // Try to find the result
    const result = await QuizResult.findById(req.params.resultId);
    console.log('🔍 Direct lookup result:', result ? 'Found' : 'Not found');
    
    if (result) {
      console.log('🔍 Result details:', {
        id: result._id,
        student: result.student,
        quiz: result.quiz,
        quizTitle: result.quizTitle,
        percentage: result.percentage,
        createdAt: result.createdAt
      });
    }
    
    // Also check if there are any results for this user
    const userResults = await QuizResult.find({ student: req.user._id }).limit(5);
    console.log('🔍 User has', userResults.length, 'results');
    
    res.json({
      success: true,
      resultExists: !!result,
      resultDetails: result,
      userResultsCount: userResults.length,
      userResults: userResults.map(r => ({
        id: r._id,
        quizTitle: r.quizTitle,
        percentage: r.percentage,
        createdAt: r.createdAt
      }))
    });
  } catch (error) {
    console.error('❌ Error in debug route:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// Route to fix existing quiz options
app.post('/fix-quiz-options/:quizId', requireAuth, requireRole(['teacher']), async (req, res) => {
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
app.post('/recreate-quiz/:quizId', requireAuth, requireRole(['teacher']), async (req, res) => {
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
      organizationId: req.user.organizationId, // Add organization context for SaaS
      isApproved: true, // Auto-approve teacher quizzes
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
app.get('/debug-quiz/:quizId', requireAuth, async (req, res) => {
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
app.get('/my-results', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const results = await QuizResult.find({ student: req.user._id })
      .populate('quiz')
      .sort({ createdAt: -1 });
    
    // Add isArchived property to each result
    const resultsWithArchiveStatus = results.map(result => {
      const resultObj = result.toObject();
      // A quiz is considered archived if it has been taken more than once
      resultObj.isArchived = result.attemptNumber > 1;
      return resultObj;
    });
    
    res.render('my-results', { results: resultsWithArchiveStatus, user: req.user });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).send('Error fetching results');
  }
});

// Route to view quiz questions in database
app.get('/view-quiz/:quizId', requireAuth, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId).populate('createdBy');
    if (!quiz) {
      return res.status(404).send('Quiz not found');
    }
    
    // Check if this is a competitive quiz and user is a student
    if (quiz.quizType === 'competitive' && req.user.role === 'student') {
      return res.status(403).render('error', { 
        message: 'Competitive quizzes can only be accessed through a session. Please join using the session code provided by your teacher.' 
      });
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
    
    // Create super admin user (doesn't require organizationId)
    const adminUser = new User({
      googleId: 'test-admin-' + Date.now(),
      displayName: 'Test Admin',
      email: 'sarika.katti@gmail.com',
      role: 'super_admin', // Changed to super_admin for SaaS
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
app.get('/make-admin', requireAuth, async (req, res) => {
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
      existingAdmin.role = 'super_admin'; // Changed to super_admin for SaaS
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
        role: 'super_admin', // Changed to super_admin for SaaS
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
      existingAdmin.role = 'super_admin'; // Changed to super_admin for SaaS
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
        role: 'super_admin', // Changed to super_admin for SaaS
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
app.post('/approve-teacher/:userId', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
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

// Quiz approval endpoint - NO LONGER NEEDED (all quizzes auto-approved)
// Keeping endpoint for backward compatibility but it does nothing
app.post('/approve-quiz/:quizId', requireAuth, requireRole(['admin', 'super_admin']), async (req, res) => {
  // All quizzes are now auto-approved, so just redirect
  res.redirect('/admin/dashboard');
});

// Migration endpoint to approve all existing quizzes
app.get('/migrate/approve-all-quizzes', async (req, res) => {
  try {
    const result = await Quiz.updateMany(
      { isApproved: false },
      { isApproved: true }
    );
    
    res.send(`
      <h2>Quiz Approval Migration Complete</h2>
      <p>Updated ${result.modifiedCount} quizzes to approved status.</p>
      <p>All quizzes are now auto-approved.</p>
      <a href="/dashboard">Go to Dashboard</a>
    `);
  } catch (error) {
    console.error('Error migrating quizzes:', error);
    res.status(500).send('Error migrating quizzes');
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
        return res.redirect('/signup?error=Please create an organization or ask a teacher for an invitation');
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
      return res.redirect('/signup?error=Please create an organization first');
    }
    
    // Add null check for req.user.role
    if (!req.user || !req.user.role) {
      return res.redirect('/login?error=User role not set. Please contact administrator.');
    }
    
    // Redirect based on role and organization context
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
      // Super admins and admins go to admin dashboard
      res.redirect('/admin/dashboard');
    } else if (req.user.role === 'teacher' && req.user.organizationId) {
      // Teachers with organization context should go to teacher dashboard
      res.redirect('/teacher/dashboard');
    } else if (req.user.organizationRole === 'owner') {
      // Organization owners go to organization dashboard
      res.redirect('/organization/dashboard');
    } else {
    res.redirect('/dashboard');
    }
  });
});

// API routes for session management
app.post('/api/activity-update', requireAuth, (req, res) => {
  // Update session last activity
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  res.json({ success: true });
});

// ===== PODCAST ROUTES =====

// Get all podcasts for a teacher
app.get('/api/teacher-podcasts', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    const podcasts = await Podcast.find({ createdBy: req.user._id })
      .sort({ createdAt: -1 });

    // Generate pre-signed URLs for audio files
    const podcastsWithUrls = await Promise.all(
      podcasts.map(async (podcast) => {
        const podcastObj = podcast.toObject();
        if (podcastObj.audioUrl) {
          try {
            const presignedUrl = await generatePresignedUrl(podcastObj.audioUrl, 3600);
            podcastObj.audioUrl = presignedUrl || podcastObj.audioUrl;
          } catch (error) {
            console.error(`Error generating pre-signed URL for podcast ${podcast._id}:`, error);
            // Keep original URL as fallback
          }
        }
        return podcastObj;
      })
    );

    res.json({ success: true, podcasts: podcastsWithUrls });
  } catch (error) {
    console.error('Error fetching teacher podcasts:', error);
    res.status(500).json({ success: false, message: 'Error fetching podcasts' });
  }
});

// Get podcasts for students (filtered by grade and organization)
app.get('/api/student-podcasts', requireAuth, requireRole(['student']), async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    const { grade, subject } = req.query;

    let query = {
      isPublished: true,
      organizationId: req.user.organizationId
    };

    if (grade && grade !== 'all') {
      query.gradeLevel = grade;
    }

    if (subject && subject !== 'all') {
      query.subjects = subject;
    }

    const podcasts = await Podcast.find(query)
      .sort({ createdAt: -1 });

    // Generate pre-signed URLs for audio files
    const podcastsWithUrls = await Promise.all(
      podcasts.map(async (podcast) => {
        const podcastObj = podcast.toObject();
        if (podcastObj.audioUrl) {
          try {
            const presignedUrl = await generatePresignedUrl(podcastObj.audioUrl, 3600);
            podcastObj.audioUrl = presignedUrl || podcastObj.audioUrl;
          } catch (error) {
            console.error(`Error generating pre-signed URL for podcast ${podcast._id}:`, error);
            // Keep original URL as fallback
          }
        }
        return podcastObj;
      })
    );

    res.json({ success: true, podcasts: podcastsWithUrls });
  } catch (error) {
    console.error('Error fetching student podcasts:', error);
    res.status(500).json({ success: false, message: 'Error fetching podcasts' });
  }
});

// Create new podcast
app.post('/api/create-podcast', requireAuth, requireRole(['teacher']), requireApprovedTeacher, audioUpload.single('audioFile'), async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    const { title, description, gradeLevel, subjects, tags, transcription, isTranscriptionEnabled } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No audio file provided' });
    }
    
    // Upload audio file to S3
    const audioUrl = await uploadToS3(req.file, 'podcasts');
    
    // Parse subjects and tags arrays
    const subjectsArray = subjects ? JSON.parse(subjects) : [];
    const tagsArray = tags ? JSON.parse(tags) : [];
    
    // Map MIME type to audio format
    const mimeToFormat = {
      'audio/mp3': 'mp3',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/m4a': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/aac': 'aac',
      'audio/mp4': 'm4a',
      'audio/flac': 'flac',
      'audio/webm': 'webm',
      'audio/x-aac': 'aac'
    };
    
    const audioFormat = mimeToFormat[req.file.mimetype] || 'mp3';
    
    console.log('=== PODCAST CREATION DEBUG ===');
    console.log('File MIME type:', req.file.mimetype);
    console.log('Mapped audio format:', audioFormat);
    console.log('File size:', req.file.size);
    console.log('Duration from form:', req.body.duration);
    
    const podcast = new Podcast({
      title,
      description,
      audioUrl,
      duration: req.body.duration || 0,
      fileSize: req.file.size,
      audioFormat: audioFormat,
      gradeLevel,
      subjects: subjectsArray,
      tags: tagsArray,
      transcription: transcription || '',
      isTranscriptionEnabled: isTranscriptionEnabled === 'true',
      createdBy: req.user._id,
      createdByName: req.user.displayName,
      organizationId: req.user.organizationId
    });
    
    await podcast.save();
    
    res.json({ success: true, podcast, message: 'Podcast created successfully' });
  } catch (error) {
    console.error('Error creating podcast:', error);
    res.status(500).json({ success: false, message: 'Error creating podcast' });
  }
});

// Update podcast
app.put('/api/update-podcast/:id', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    const { title, description, gradeLevel, subjects, tags, transcription, isTranscriptionEnabled } = req.body;
    
    const podcast = await Podcast.findOneAndUpdate(
      { _id: req.params.id, createdBy: req.user._id },
      {
        title,
        description,
        gradeLevel,
        subjects: JSON.parse(subjects || '[]'),
        tags: JSON.parse(tags || '[]'),
        transcription,
        isTranscriptionEnabled: isTranscriptionEnabled === 'true'
      },
      { new: true, runValidators: true }
    );
    
    if (!podcast) {
      return res.status(404).json({ success: false, message: 'Podcast not found' });
    }
    
    res.json({ success: true, podcast, message: 'Podcast updated successfully' });
  } catch (error) {
    console.error('Error updating podcast:', error);
    res.status(500).json({ success: false, message: 'Error updating podcast' });
  }
});

// Delete podcast
app.delete('/api/delete-podcast/:id', requireAuth, requireRole(['teacher']), requireApprovedTeacher, async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    const podcast = await Podcast.findOneAndDelete({ _id: req.params.id, createdBy: req.user._id });
    
    if (!podcast) {
      return res.status(404).json({ success: false, message: 'Podcast not found' });
    }
    
    // Delete audio file from S3
    if (podcast.audioUrl) {
      await deleteFromS3(podcast.audioUrl);
    }
    
    res.json({ success: true, message: 'Podcast deleted successfully' });
  } catch (error) {
    console.error('Error deleting podcast:', error);
    res.status(500).json({ success: false, message: 'Error deleting podcast' });
  }
});

// Get single podcast details
app.get('/api/podcast/:id', requireAuth, async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    const podcast = await Podcast.findById(req.params.id);

    if (!podcast) {
      return res.status(404).json({ success: false, message: 'Podcast not found' });
    }

    // Generate pre-signed URL for audio file
    const podcastObj = podcast.toObject();
    if (podcastObj.audioUrl) {
      try {
        const presignedUrl = await generatePresignedUrl(podcastObj.audioUrl, 3600);
        podcastObj.audioUrl = presignedUrl || podcastObj.audioUrl;
      } catch (error) {
        console.error(`Error generating pre-signed URL for podcast ${podcast._id}:`, error);
        // Keep original URL as fallback
      }
    }

    res.json({ success: true, podcast: podcastObj });
  } catch (error) {
    console.error('Error fetching podcast:', error);
    res.status(500).json({ success: false, message: 'Error fetching podcast' });
  }
});

// Update podcast play count
app.post('/api/podcast-play/:id', requireAuth, async (req, res) => {
  try {
    const Podcast = require('./models/Podcast');
    await Podcast.findByIdAndUpdate(req.params.id, { $inc: { playCount: 1 } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating play count:', error);
    res.status(500).json({ success: false });
  }
});

app.post('/api/extend-session', requireAuth, (req, res) => {
  // Extend session by updating last activity
  if (req.session) {
    req.session.lastActivity = Date.now();
  }
  res.json({ success: true, message: 'Session extended' });
});

// Debug endpoint to check user authentication status
app.get('/api/debug-auth', (req, res) => {
  console.log('🔍 Debug auth endpoint called');
  console.log('Session:', req.session);
  console.log('User:', req.user);
  console.log('isAuthenticated:', req.isAuthenticated ? req.isAuthenticated() : 'undefined');
  
  res.json({
    session: req.session ? {
      id: req.session.id,
      user: req.session.user,
      lastActivity: req.session.lastActivity
    } : null,
    user: req.user,
    isAuthenticated: req.isAuthenticated ? req.isAuthenticated() : false,
    headers: req.headers
  });
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