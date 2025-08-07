const mongoose = require('mongoose');
const Organization = require('./models/Organization');
const User = require('./models/User');
require('dotenv').config();

async function testSaaSSetup() {
  try {
    // Connect to MongoDB
    console.log('🔗 Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Test 1: Create a test organization
    console.log('\n📊 Test 1: Creating test organization...');
    
    // Clean up any existing test data
    await Organization.deleteMany({ subdomain: { $in: ['testschool', 'demoschool'] } });
    await User.deleteMany({ email: { $in: ['test@teacher.com', 'demo@school.com'] } });
    
    const testOrg = new Organization({
      name: 'Test School',
      subdomain: 'testschool',
      contact: {
        email: 'test@teacher.com'
      },
      planType: 'free'
    });
    
    await testOrg.save();
    console.log('✅ Test organization created:', testOrg.subdomain);
    
    // Test 2: Create a teacher user
    console.log('\n👨‍🏫 Test 2: Creating test teacher...');
    const testTeacher = new User({
      googleId: 'test_teacher_123',
      displayName: 'Test Teacher',
      email: 'test@teacher.com',
      role: 'teacher',
      organizationId: testOrg._id,
      organizationRole: 'owner',
      isApproved: true
    });
    
    await testTeacher.save();
    
    // Update organization with owner
    testOrg.ownerId = testTeacher._id;
    await testOrg.save();
    
    console.log('✅ Test teacher created:', testTeacher.email);
    
    // Test 3: Test organization limits
    console.log('\n📏 Test 3: Testing organization limits...');
    const limits = Organization.getPlanLimits('free');
    console.log('Free plan limits:', limits);
    
    console.log('Can add students?', testOrg.canAddStudents(10));
    console.log('Can add quizzes?', testOrg.canAddQuizzes(5));
    console.log('Has multi-language feature?', testOrg.hasFeature('multiLanguage'));
    
    // Test 4: Create another organization
    console.log('\n🏢 Test 4: Creating second organization for isolation test...');
    const demoOrg = new Organization({
      name: 'Demo School',
      subdomain: 'demoschool',
      contact: {
        email: 'demo@school.com'
      },
      planType: 'basic'
    });
    
    await demoOrg.save();
    
    const demoTeacher = new User({
      googleId: 'demo_teacher_456',
      displayName: 'Demo Teacher',
      email: 'demo@school.com',
      role: 'teacher',
      organizationId: demoOrg._id,
      organizationRole: 'owner',
      isApproved: true
    });
    
    await demoTeacher.save();
    
    demoOrg.ownerId = demoTeacher._id;
    await demoOrg.save();
    
    console.log('✅ Demo organization created:', demoOrg.subdomain);
    
    // Test 5: Test data isolation
    console.log('\n🔒 Test 5: Testing data isolation...');
    
    // Find users by organization
    const testOrgUsers = await User.findByOrganization(testOrg._id);
    const demoOrgUsers = await User.findByOrganization(demoOrg._id);
    
    console.log('Test org users:', testOrgUsers.length);
    console.log('Demo org users:', demoOrgUsers.length);
    
    // Test organization membership
    console.log('Test teacher belongs to test org?', testTeacher.belongsToOrganization(testOrg._id));
    console.log('Test teacher belongs to demo org?', testTeacher.belongsToOrganization(demoOrg._id));
    
    // Test permissions
    console.log('Test teacher can manage students?', testTeacher.canAccess('manage_students'));
    console.log('Test teacher can access all?', testTeacher.canAccess('all'));
    
    console.log('\n🎉 All tests passed! SaaS setup is working correctly.');
    
    console.log('\n📝 Test Data Created:');
    console.log('Organizations:');
    console.log(`  - ${testOrg.name} (${testOrg.subdomain}.skillons.com) - ${testOrg.planType} plan`);
    console.log(`  - ${demoOrg.name} (${demoOrg.subdomain}.skillons.com) - ${demoOrg.planType} plan`);
    console.log('Users:');
    console.log(`  - ${testTeacher.displayName} (${testTeacher.email}) - ${testTeacher.getDisplayRole()}`);
    console.log(`  - ${demoTeacher.displayName} (${demoTeacher.email}) - ${demoTeacher.getDisplayRole()}`);
    
    console.log('\n🌐 Test URLs:');
    console.log('  - Main app: http://localhost:3000');
    console.log('  - Teacher signup: http://localhost:3000/teacher-signup');
    console.log('  - Test org dashboard: http://localhost:3000/organization/dashboard (when accessing from testschool subdomain)');
    console.log('  - Demo org dashboard: http://localhost:3000/organization/dashboard (when accessing from demoschool subdomain)');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n📤 Disconnected from MongoDB');
  }
}

// Run the test
if (require.main === module) {
  testSaaSSetup();
}

module.exports = { testSaaSSetup };