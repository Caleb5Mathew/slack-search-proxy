# SlackGPT - Slack Search Proxy

A ChatGPT-compatible OAuth proxy for Slack search with usage tracking.

## Features

- OAuth integration with Slack for secure user authentication
- Search Slack messages via ChatGPT
- Thread retrieval from Slack conversations  
- Automatic usage tracking in CSV format
- Redis persistence (optional)
- Admin dashboard for user management

## Environment Variables

### Required
- `SLACK_CLIENT_ID` - Your Slack app client ID
- `SLACK_CLIENT_SECRET` - Your Slack app client secret
- `JWT_SECRET` - Long random string for JWT signing

### Optional
- `ADMIN_KEY` - Admin key for accessing `/admin/users` endpoint
- `UPSTASH_REDIS_REST_URL` - Redis URL for persistence
- `UPSTASH_REDIS_REST_TOKEN` - Redis token for persistence
- `PORT` - Server port (default: 3000)

### CSV Tracking (Optional)
- `GITHUB_TOKEN` - Fine-grained Personal Access Token with Contents: Read+Write
- `GITHUB_OWNER` - Your GitHub username (e.g. `caleb5mathews`)
- `GITHUB_REPO` - Your repository name (e.g. `SlackGPT`)

### Firebase Integration (Optional)
- `FIREBASE_PROJECT_ID` - Your Firebase project ID
- `FIREBASE_PRIVATE_KEY` - Firebase service account private key (with \n replaced with actual newlines)
- `FIREBASE_CLIENT_EMAIL` - Firebase service account client email

## CSV Usage Tracking

When GitHub environment variables are configured, the app automatically tracks usage in a `usage_stats.csv` file in your repository. The CSV contains:

- `user_name` - Slack display name
- `team_name` - Slack workspace name
- `user_id` - Slack user ID
- `team_id` - Slack team ID
- `questions` - Number of search queries made

The file is automatically created and updated on each search query, sorted by question count (highest first).

## Firebase User Analytics

When Firebase environment variables are configured, the app automatically tracks user activity and analytics in Firestore:

### Collections Created:
- **`userStats`** - User analytics and activity tracking with:
  - **User Information**: firstName, lastName, userName, userId
  - **Team Information**: teamName, teamId
  - **Activity Metrics**: questionCount, firstQuestionAt, lastQuestionAt
  - **Session Tracking**: firstSeen, lastSeen timestamps

### What Gets Tracked:
- ✅ **Who** is using the service (first name, last name, team)
- ✅ **How many questions** each person has asked
- ✅ **When** they first used it and last used it
- ❌ **NOT** the actual question content (privacy-focused)

### Debug Endpoint:
- `GET /debug/firebase` - Test Firebase connectivity (requires admin key)

## Setup

1. Create a Slack app with OAuth scopes: `search:read,channels:history,groups:history,im:history,mpim:history`
2. Set up environment variables in your deployment platform
3. Deploy to Vercel/similar platform
4. Configure ChatGPT with your OAuth endpoints

## Endpoints

- `GET /oauth/authorize` - OAuth authorization URL for ChatGPT
- `POST /oauth/token` - OAuth token exchange
- `GET /slack/search` - Search Slack messages (requires auth)
- `GET /slack/thread` - Get thread replies (requires auth)
- `GET /admin/users` - View authorized users (requires admin key)
- `GET /debug/firebase` - Test Firebase connectivity (requires admin key)
- `GET /` - Health check 