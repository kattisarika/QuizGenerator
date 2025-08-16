const nodemailer = require('nodemailer');

// Email service for sending invitations and notifications
class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;
    this.init();
  }

  init() {
    // Check if email configuration is available
    if (process.env.EMAIL_SERVICE && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        this.transporter = nodemailer.createTransporter({
          service: process.env.EMAIL_SERVICE, // gmail, sendgrid, etc.
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
          }
        });
        this.isConfigured = true;
        console.log('Email service configured successfully');
      } catch (error) {
        console.error('Failed to configure email service:', error);
        this.isConfigured = false;
      }
    } else {
      console.log('Email service not configured - missing environment variables');
      this.isConfigured = false;
    }
  }

  async sendStudentInvitation(invitationData) {
    const { email, organizationName, organizationCode, teacherName, gradeLevel } = invitationData;
    
    if (!this.isConfigured) {
      console.log('Email service not configured, skipping email send');
      return { success: false, message: 'Email service not configured' };
    }

    const subject = `You're invited to join ${organizationName}!`;
    const htmlContent = this.generateInvitationHTML(invitationData);
    const textContent = this.generateInvitationText(invitationData);

    try {
      const info = await this.transporter.sendMail({
        from: `"${organizationName}" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        text: textContent,
        html: htmlContent
      });

      console.log('Invitation email sent successfully:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Failed to send invitation email:', error);
      return { success: false, error: error.message };
    }
  }

  generateInvitationHTML(data) {
    const { email, organizationName, organizationCode, teacherName, gradeLevel, subjects } = data;
    const subjectsText = subjects && subjects.length > 0 ? subjects.join(', ') : 'General Studies';
    const signupUrl = `${process.env.APP_URL || 'https://skillons.herokuapp.com'}/signup`;

    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .cta-button { background: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
        .info-box { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .organization-code { font-size: 24px; font-weight: bold; color: #2196F3; background: white; padding: 10px; border-radius: 5px; text-align: center; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎓 You're Invited to Join ${organizationName}!</h1>
            <p>Your teacher ${teacherName} has invited you to join their quiz platform</p>
        </div>
        <div class="content">
            <h2>Welcome to Your Learning Journey!</h2>
            <p>Hi there! You've been invited to join <strong>${organizationName}</strong> where you can:</p>
            
            <ul>
                <li>📚 Take interactive quizzes</li>
                <li>📖 Access study materials</li>
                <li>📊 Track your progress</li>
                <li>🏆 Compete with classmates</li>
            </ul>

            <div class="info-box">
                <h3>Your Invitation Details:</h3>
                <p><strong>Organization:</strong> ${organizationName}</p>
                <p><strong>Teacher:</strong> ${teacherName}</p>
                <p><strong>Grade Level:</strong> ${gradeLevel}</p>
                <p><strong>Subjects:</strong> ${subjectsText}</p>
            </div>

            <h3>How to Join:</h3>
            <p><strong>Option 1: Quick Signup</strong></p>
            <p>Click the button below to create your account:</p>
            <a href="${signupUrl}?code=${organizationCode}" class="cta-button">Create My Account</a>

            <p><strong>Option 2: Manual Signup</strong></p>
            <p>1. Go to: <a href="${signupUrl}">${signupUrl}</a></p>
            <p>2. Select "Student" when prompted</p>
            <p>3. Enter this organization code:</p>
            <div class="organization-code">${organizationCode}</div>

            <div class="info-box">
                <h4>What happens next?</h4>
                <p>✅ Create your account with Google Sign-In<br>
                ✅ You'll be automatically added to ${organizationName}<br>
                ✅ Start taking quizzes and accessing study materials<br>
                ✅ Your teacher can track your progress</p>
            </div>

            <p>If you have any questions, please contact your teacher ${teacherName}.</p>
            
            <p>Welcome to SkillOns<br>
            The Learning Platform Team</p>
        </div>
    </div>
</body>
</html>`;
  }

  generateInvitationText(data) {
    const { email, organizationName, organizationCode, teacherName, gradeLevel, subjects } = data;
    const subjectsText = subjects && subjects.length > 0 ? subjects.join(', ') : 'General Studies';
    const signupUrl = `${process.env.APP_URL || 'https://skillons.herokuapp.com'}/signup`;

    return `
You're Invited to Join ${organizationName}!

        Hi there! Your teacher ${teacherName} has invited you to join ${organizationName} on SkillOns

Your Invitation Details:
- Organization: ${organizationName}
- Teacher: ${teacherName}
- Grade Level: ${gradeLevel}
- Subjects: ${subjectsText}

How to Join:

Option 1: Quick Signup
Visit: ${signupUrl}?code=${organizationCode}

Option 2: Manual Signup
1. Go to: ${signupUrl}
2. Select "Student" when prompted
3. Enter organization code: ${organizationCode}

What you can do:
📚 Take interactive quizzes
📖 Access study materials
📊 Track your progress
🏆 Compete with classmates

If you have any questions, please contact your teacher ${teacherName}.

        Welcome to SkillOns
The Learning Platform Team
`;
  }

  // Test email configuration
  async testConnection() {
    if (!this.isConfigured) {
      return { success: false, message: 'Email service not configured' };
    }

    try {
      await this.transporter.verify();
      return { success: true, message: 'Email service connection verified' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new EmailService();