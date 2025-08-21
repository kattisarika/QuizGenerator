# AWS S3 Setup for Complex Quiz Storage

## Overview
Complex quiz data (drag-and-drop canvas elements) can be stored in AWS S3 for better performance and scalability. If S3 is not configured, the system will automatically fall back to storing data in MongoDB.

## Environment Variables Required

Add these environment variables to your `.env` file or Heroku config vars:

```env
# AWS S3 Configuration (Optional)
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=skillons-quiz-data
```

## AWS S3 Setup Steps

### 1. Create AWS Account
- Sign up at https://aws.amazon.com/
- Navigate to AWS Console

### 2. Create S3 Bucket
```bash
# Using AWS CLI (optional)
aws s3 mb s3://skillons-quiz-data --region us-east-1
```

Or via AWS Console:
- Go to S3 service
- Click "Create bucket"
- Name: `skillons-quiz-data`
- Region: `us-east-1`
- Keep default settings
- Click "Create bucket"

### 3. Create IAM User
- Go to IAM service
- Click "Users" → "Add user"
- Username: `skillons-s3-user`
- Access type: "Programmatic access"
- Attach policy: `AmazonS3FullAccess` (or create custom policy)

### 4. Custom IAM Policy (Recommended)
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": "arn:aws:s3:::skillons-quiz-data/*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
            "Resource": "arn:aws:s3:::skillons-quiz-data"
        }
    ]
}
```

### 5. Get Access Keys
- After creating user, download the CSV with:
  - Access Key ID
  - Secret Access Key
- Add these to your environment variables

## Heroku Deployment

Set config vars in Heroku:
```bash
heroku config:set AWS_ACCESS_KEY_ID=your_access_key_id
heroku config:set AWS_SECRET_ACCESS_KEY=your_secret_access_key
heroku config:set AWS_REGION=us-east-1
heroku config:set S3_BUCKET_NAME=skillons-quiz-data
```

## Benefits of S3 Storage

1. **Performance**: Faster loading of complex quiz data
2. **Scalability**: No MongoDB document size limits
3. **Cost**: S3 storage is cheaper for large data
4. **Reliability**: AWS S3 99.999999999% durability
5. **Backup**: Automatic versioning and backup options

## Fallback Behavior

If S3 is not configured or fails:
- System automatically stores data in MongoDB
- No functionality is lost
- Performance may be slower for very complex quizzes
- MongoDB document size limits apply (16MB)

## Data Structure in S3

```json
{
  "elements": [
    {
      "id": "element-1",
      "type": "textbox",
      "x": 100,
      "y": 200,
      "width": 300,
      "height": 100,
      "content": "Sample text",
      "style": {
        "fontSize": "14px",
        "color": "#000000"
      }
    }
  ],
  "canvasSize": {
    "width": 1000,
    "height": 800
  },
  "metadata": {
    "title": "Quiz Title",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "createdBy": "user_id"
  }
}
```

## Security

- S3 objects are encrypted at rest (AES256)
- Access controlled via IAM policies
- Objects are private by default
- Access only through authenticated API calls

## Monitoring

- Check AWS CloudWatch for S3 metrics
- Monitor application logs for S3 upload/download status
- Set up S3 bucket notifications if needed

## Cost Estimation

For 1000 complex quizzes (~1MB each):
- S3 Storage: ~$0.023/month
- S3 Requests: ~$0.01/month
- Total: ~$0.033/month

Much cheaper than MongoDB Atlas storage for large data!
