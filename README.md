# SkillOns 🎓

A comprehensive quiz application with role-based access control, online database, and session management.

## 🌟 Features

### 🔐 Authentication & Authorization
- **Google OAuth Integration**: Secure login with Google accounts
- **Role-Based Access Control**: Student, Teacher, and Admin roles
- **Session Management**: 30-minute timeout with activity tracking
- **Automatic Logout**: Session expiration with warnings

### 📚 Quiz Management
- **File Upload Support**: PDF and DOC/DOCX question papers
- **Automatic Parsing**: Extract questions and answers from uploaded files
- **Quiz Creation**: Teachers can create quizzes with multiple choice questions
- **Quiz Approval**: Admin approval system for quizzes
- **Quiz Deletion**: Teachers can delete their own quizzes

### 🎯 Quiz Taking
- **Interactive Interface**: One question at a time with navigation
- **Timer**: Real-time quiz timer
- **Progress Tracking**: Visual progress bar and question indicators
- **Answer Validation**: Automatic scoring and result calculation
- **Attempt Limits**: Maximum 3 attempts per quiz per student

### 📊 Results & Analytics
- **Detailed Results**: Score, percentage, and answer analysis
- **Performance Insights**: Performance trends and statistics
- **Quiz History**: Complete history of all quiz attempts
- **Grade Filtering**: Quizzes filtered by student grade level and subjects

### 🗄️ Database
- **MongoDB Atlas**: Online cloud database
- **Persistent Storage**: All data stored securely in the cloud
- **User Profiles**: Grade levels and subject preferences
- **Quiz Results**: Complete quiz attempt history

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or higher)
- MongoDB Atlas account
- Google OAuth credentials

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd QuizGenerator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```
   
   Update `.env` with your credentials:
   ```bash
   # MongoDB Atlas
   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/take_quiz_now?retryWrites=true&w=majority
   
   # Google OAuth
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   
   # Session
   SESSION_SECRET=your_session_secret
   
   # Server
   PORT=3000
   NODE_ENV=development
   ```

4. **Start the application**
   ```bash
   npm start
   ```

5. **Access the application**
   - Main URL: http://localhost:3000
   - Login: http://localhost:3000/login
   - Test Login: http://localhost:3000/temp-login

## 📁 Project Structure

```
QuizGenerator/
├── models/                 # Database schemas
│   ├── User.js           # User model
│   ├── Quiz.js           # Quiz model
│   └── QuizResult.js     # Quiz results model
├── public/               # Static files
│   ├── css/             # Stylesheets
│   └── js/              # Client-side JavaScript
├── views/               # EJS templates
│   ├── dashboard.ejs    # Main dashboard
│   ├── login.ejs        # Login page
│   ├── temp-login.ejs   # Test login
│   └── ...              # Other view files
├── uploads/             # File upload directory
├── server.js            # Main application file
├── package.json         # Dependencies
└── README.md           # This file
```

## 🔧 Configuration

### MongoDB Atlas Setup
1. Create MongoDB Atlas account
2. Create a new cluster
3. Set up database access (username/password)
4. Configure network access (IP whitelist)
5. Get connection string and update `.env`

### Google OAuth Setup
1. Go to Google Cloud Console
2. Create new project
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
6. Update `.env` with Client ID and Secret

## 👥 User Roles

### Student
- Browse available quizzes
- Take quizzes (max 3 attempts)
- View results and performance
- Update profile (grade level, subjects)

### Teacher
- Create quizzes with file upload
- View and manage quizzes
- Delete quizzes
- Upload question papers and answer keys

### Admin
- Approve teacher accounts
- Approve quizzes
- Manage system settings
- View system analytics

## 🛠️ API Endpoints

### Authentication
- `GET /login` - Login page
- `GET /auth/google` - Google OAuth
- `GET /auth/google/callback` - OAuth callback
- `GET /logout` - Logout

### Quiz Management
- `GET /create-quiz` - Quiz creation page
- `POST /create-quiz` - Create new quiz
- `GET /view-quiz/:id` - View quiz details
- `DELETE /delete-quiz/:id` - Delete quiz

### Quiz Taking
- `GET /take-quiz/:id` - Take quiz
- `POST /submit-quiz/:id` - Submit quiz answers
- `GET /quiz-result/:id` - View results

### User Management
- `GET /select-role` - Role selection
- `POST /select-role` - Set user role
- `GET /student-profile` - Student profile
- `POST /update-student-profile` - Update profile

## 🔒 Security Features

- **Session Timeout**: 30-minute automatic logout
- **Activity Tracking**: Real-time user activity monitoring
- **Role-based Access**: Different permissions for each role
- **Input Validation**: Server-side validation for all inputs
- **File Upload Security**: Restricted file types and sizes

## 📊 Database Schema

### User
- `googleId`: Google OAuth ID
- `displayName`: User's display name
- `email`: User's email
- `role`: Student/Teacher/Admin
- `isApproved`: Approval status
- `gradeLevel`: Student grade level
- `subjects`: Student subjects

### Quiz
- `title`: Quiz title
- `description`: Quiz description
- `questions`: Array of questions
- `createdBy`: Teacher who created
- `isApproved`: Approval status
- `gradeLevel`: Target grade level
- `subjects`: Target subjects

### QuizResult
- `student`: Student reference
- `quiz`: Quiz reference
- `answers`: Array of answers
- `score`: Total score
- `percentage`: Score percentage
- `timeTaken`: Time taken
- `completedAt`: Completion timestamp

## 🚀 Deployment

### Environment Variables
Make sure to set these in production:
- `NODE_ENV=production`
- `SESSION_SECRET`: Strong random string
- `MONGODB_URI`: Production database URL
- `GOOGLE_CLIENT_ID`: Production OAuth credentials
- `GOOGLE_CLIENT_SECRET`: Production OAuth secret

### Production Considerations
- Use HTTPS in production
- Set up proper domain for OAuth redirects
- Configure MongoDB Atlas for production
- Set up proper logging and monitoring
- Use environment-specific configurations

### Heroku Deployment

1. **Create Heroku app**
   ```bash
   heroku create your-app-name
   ```

2. **Set environment variables**
   ```bash
   heroku config:set NODE_ENV=production
   heroku config:set SESSION_SECRET=your_strong_session_secret
   heroku config:set MONGODB_URI=your_mongodb_atlas_uri
   heroku config:set GOOGLE_CLIENT_ID=your_google_client_id
   heroku config:set GOOGLE_CLIENT_SECRET=your_google_client_secret
   heroku config:set BASE_URL=https://your-app-name.herokuapp.com
   ```

3. **Update Google OAuth settings**
   - Go to Google Cloud Console
   - Add your Heroku domain to authorized redirect URIs:
     - `https://your-app-name.herokuapp.com/auth/google/callback`

4. **Deploy to Heroku**
   ```bash
   git add .
   git commit -m "Configure for Heroku deployment"
   git push heroku main
   ```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📝 License

This project is licensed under the MIT License.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the documentation
- Review the code comments

---

**Built with ❤️ using Node.js, Express, MongoDB, and Google OAuth** 