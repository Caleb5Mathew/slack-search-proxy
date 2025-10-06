// server.js
import express from "express";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { Redis } from "@upstash/redis";
import admin from "firebase-admin";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- CONFIG ----------
const {
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  JWT_SECRET,                 // make this a long random string
  ADMIN_KEY = "",             // optional: for /admin/users
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  // GitHub integration for CSV tracking
  GITHUB_TOKEN,               // fine-grained PAT with Contents: Read+Write
  GITHUB_OWNER,               // e.g. caleb5mathews
  GITHUB_REPO,                // e.g. SlackGPT
  SLACK_TEAM_DOMAIN,          // e.g. fervoenergy (for workspace-specific OAuth)
  // Firebase integration for question streaming
  FIREBASE_PROJECT_ID,        // Your Firebase project ID
  FIREBASE_PRIVATE_KEY,       // Firebase private key (with \n replaced with actual newlines)
  FIREBASE_CLIENT_EMAIL,      // Firebase client email
  PORT
} = process.env;

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const CSV_FILE_PATH = "usage_stats.csv"; // CSV file in repo root

// Optional: persistent store (survives redeploys) — falls back to in-memory if not set
const redis = (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;

// Firebase initialization
let firestore = null;
if (FIREBASE_PROJECT_ID && FIREBASE_PRIVATE_KEY && FIREBASE_CLIENT_EMAIL) {
  try {
    const serviceAccount = {
      projectId: FIREBASE_PROJECT_ID,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: FIREBASE_CLIENT_EMAIL,
    };
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID,
    });
    
    firestore = admin.firestore();
    console.log('[FIREBASE] Successfully initialized Firestore');
  } catch (error) {
    console.error('[FIREBASE] Failed to initialize:', error.message);
  }
} else {
  console.log('[FIREBASE] Firebase not configured, skipping Firestore integration');
}

// In-memory cache of authorized users (ephemeral; resets on cold start)
const USERS = new Map(); // key = `${team_id}:${user_id}` -> { connected_at, last_seen, team_id, team, user_id, user }

// ---------- HELPERS ----------
const nowISO = () => new Date().toISOString();
const userKey = (team_id, user_id) => `user:${team_id}:${user_id}`;

// ---------- GITHUB CSV FUNCTIONS ----------
async function getFileFromGitHub(path) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.log("[CSV] GitHub not configured, skipping CSV tracking");
    return null;
  }
  
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    
    if (response.status === 404) {
      return null; // File doesn't exist yet
    }
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    const data = await response.json();
    return {
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      sha: data.sha
    };
  } catch (error) {
    console.error('[CSV] Error reading from GitHub:', error.message);
    return null;
  }
}

async function updateFileInGitHub(path, content, sha = null) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return;
  
  try {
    const body = {
      message: `Update usage stats - ${new Date().toISOString()}`,
      content: Buffer.from(content).toString('base64')
    };
    
    if (sha) {
      body.sha = sha;
    }
    
    const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    console.log('[CSV] Successfully updated usage stats in GitHub');
  } catch (error) {
    console.error('[CSV] Error updating GitHub file:', error.message);
  }
}

async function trackUserQuestion(userIdentity) {
  try {
    // Get current CSV
    const file = await getFileFromGitHub(CSV_FILE_PATH);
    let csvContent = '';
    let userStats = new Map();
    
    // Parse existing CSV if it exists
    if (file?.content) {
      csvContent = file.content;
      const lines = csvContent.trim().split('\n');
      
      // Skip header if it exists
      const hasHeader = lines[0]?.includes('user_name') || lines[0]?.includes('team_name');
      const dataLines = hasHeader ? lines.slice(1) : lines;
      
      for (const line of dataLines) {
        if (line.trim()) {
          const [userName, teamName, userId, teamId, questionsStr] = line.split(',').map(s => s.trim());
          const questions = parseInt(questionsStr) || 0;
          userStats.set(`${teamId}:${userId}`, {
            userName,
            teamName,
            userId,
            teamId,
            questions
          });
        }
      }
    }
    
    // Update or add user
    const userKey = `${userIdentity.team_id}:${userIdentity.user_id}`;
    const existing = userStats.get(userKey);
    
    if (existing) {
      existing.questions += 1;
    } else {
      userStats.set(userKey, {
        userName: userIdentity.user,
        teamName: userIdentity.team,
        userId: userIdentity.user_id,
        teamId: userIdentity.team_id,
        questions: 1
      });
    }
    
    // Generate new CSV content
    const header = 'user_name,team_name,user_id,team_id,questions\n';
    const rows = Array.from(userStats.values())
      .sort((a, b) => b.questions - a.questions) // Sort by question count desc
      .map(user => `${user.userName},${user.teamName},${user.userId},${user.teamId},${user.questions}`)
      .join('\n');
    
    const newContent = header + rows;
    
    // Update in GitHub
    await updateFileInGitHub(CSV_FILE_PATH, newContent, file?.sha);
    
  } catch (error) {
    console.error('[CSV] Error tracking user question:', error.message);
  }
}

// ---------- FIREBASE FUNCTIONS ----------
async function trackUserActivityInFirebase(userIdentity) {
  if (!firestore) {
    console.log('[FIREBASE] Firestore not initialized, skipping user tracking');
    return;
  }
  
  try {
    // Update user stats (this handles both new users and existing users)
    await updateUserStatsInFirebase(userIdentity);
    
    console.log(`[FIREBASE] User activity tracked for ${userIdentity.user}`);
    
  } catch (error) {
    console.error('[FIREBASE] Error tracking user activity:', error.message);
  }
}

async function updateUserStatsInFirebase(userIdentity) {
  if (!firestore) return;
  
  try {
    const userStatsRef = firestore.collection('userStats').doc(`${userIdentity.team_id}_${userIdentity.user_id}`);
    
    // Parse first and last name from the full name
    const fullName = userIdentity.user || 'Unknown User';
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0] || 'Unknown';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    
    await firestore.runTransaction(async (transaction) => {
      const userStatsDoc = await transaction.get(userStatsRef);
      
      if (userStatsDoc.exists) {
        // Update existing user
        const currentData = userStatsDoc.data();
        transaction.update(userStatsRef, {
          questionCount: (currentData.questionCount || 0) + 1,
          lastQuestionAt: admin.firestore.FieldValue.serverTimestamp(),
          userName: userIdentity.user,
          firstName: firstName,
          lastName: lastName,
          teamName: userIdentity.team,
          lastSeen: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Create new user
        transaction.set(userStatsRef, {
          userId: userIdentity.user_id,
          userName: userIdentity.user,
          firstName: firstName,
          lastName: lastName,
          teamId: userIdentity.team_id,
          teamName: userIdentity.team,
          questionCount: 1,
          firstQuestionAt: admin.firestore.FieldValue.serverTimestamp(),
          lastQuestionAt: admin.firestore.FieldValue.serverTimestamp(),
          firstSeen: admin.firestore.FieldValue.serverTimestamp(),
          lastSeen: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
    
    console.log(`[FIREBASE] User stats updated for ${firstName} ${lastName} (${userIdentity.user})`);
    
  } catch (error) {
    console.error('[FIREBASE] Error updating user stats:', error.message);
  }
}

// ---------- OAUTH: AUTHORIZATION (for GPT "Authorization URL") ----------
app.get("/oauth/authorize", (req, res) => {
  // ChatGPT calls this; we bounce the user to Slack with the proper user_scope.
  const { redirect_uri, state } = req.query;
  const host = SLACK_TEAM_DOMAIN ? `${SLACK_TEAM_DOMAIN}.slack.com` : "slack.com";
  const u = new URL(`https://${host}/oauth/v2/authorize`);
  u.searchParams.set("client_id", SLACK_CLIENT_ID);
  u.searchParams.set(
    "user_scope",
    "search:read,channels:history,groups:history,im:history,mpim:history"
  );
  if (redirect_uri) u.searchParams.set("redirect_uri", redirect_uri);
  if (state) u.searchParams.set("state", state);
  return res.redirect(u.toString());
});

// ---------- OAUTH: TOKEN (for GPT "Token URL") ----------
app.post("/oauth/token", async (req, res) => {
  // ChatGPT posts: grant_type=authorization_code, code, redirect_uri
  const { code, redirect_uri } = req.body || {};
  if (!code || !redirect_uri) {
    return res.status(400).json({ error: "missing code or redirect_uri" });
  }

  // 1) Exchange code -> USER token (xoxp-…)
  const slackResp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      redirect_uri
    })
  }).then(r => r.json());

  const ok = slackResp && slackResp.ok === true;
  const userToken = slackResp?.authed_user?.access_token; // xoxp-...
  if (!ok || !userToken) {
    return res.status(400).json({ error: "slack_oauth_failed", details: slackResp });
  }

  // 2) Identify the user/team (no extra scopes required)
  const idResp = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${userToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams()
  }).then(r => r.json());

  if (!idResp?.ok) {
    return res.status(400).json({ error: "auth_test_failed", details: idResp });
  }

  const { user_id, user, team_id, team } = idResp;
  const key = `${team_id}:${user_id}`;
  const kRedis = userKey(team_id, user_id);
  const now = nowISO();

  // 3) Update in-memory registry
  if (!USERS.has(key)) {
    USERS.set(key, { connected_at: now, last_seen: now, team_id, team, user_id, user });
  } else {
    USERS.get(key).last_seen = now;
  }

  // 4) Persist (if Redis configured)
  if (redis) {
    const exists = await redis.exists(kRedis);
    if (!exists) {
      await redis.hset(kRedis, { connected_at: now, team_id, team, user_id, user });
    }
    await redis.hset(kRedis, { last_seen: now });
    await redis.sadd("users:index", kRedis);            // index of all users
    // optional TTL (comment out if you want to keep forever)
    await redis.expire(kRedis, 60 * 60 * 24 * 90);      // 90 days
  }

  console.log(`[AUTH] ${user} (${user_id}) on ${team} (${team_id}) connected at ${now}`);

  // 5) Mint JWT including identity (so downstream requests know who it is)
  const access_token = jwt.sign(
    {
      slack_user_token: userToken,
      slack_user_id: user_id,
      slack_team_id: team_id,
      user,
      team
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  );

  // 6) Standard OAuth token payload
  return res.json({
    access_token,
    token_type: "bearer",
    expires_in: TOKEN_TTL_SECONDS
  });
});

// ---------- AUTH MIDDLEWARE ----------
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const decoded = jwt.verify(bearer, JWT_SECRET);
    req.slackUserToken = decoded.slack_user_token;
    req.identity = {
      user_id: decoded.slack_user_id,
      team_id: decoded.slack_team_id,
      user: decoded.user,
      team: decoded.team
    };
    const key = `${decoded.slack_team_id}:${decoded.slack_user_id}`;
    const rec = USERS.get(key);
    const t = nowISO();
    if (rec) rec.last_seen = t;
    if (redis) {
      await redis.hset(userKey(decoded.slack_team_id, decoded.slack_user_id), { last_seen: t });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// ---------- API CALLED BY GPT ----------
app.get("/slack/search", requireAuth, async (req, res) => {
  console.log(`[CALL] /slack/search by ${req.identity?.user} (${req.identity?.user_id})`);
  
  const q = req.query.q || "";
  const count = String(req.query.limit || 50);
  
  // Make the Slack API call
  const resp = await fetch("https://slack.com/api/search.messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${req.slackUserToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ query: q, count, highlight: "true" })
  }).then(r => r.json());
  
  // Track this question in CSV (async, don't block the response)
  trackUserQuestion(req.identity).catch(err => 
    console.error('[CSV] Failed to track question:', err.message)
  );
  
  // Track user activity in Firebase (async, don't block the response)
  trackUserActivityInFirebase(req.identity).catch(err => 
    console.error('[FIREBASE] Failed to track user activity:', err.message)
  );
  
  return res.json(resp);
});

app.get("/slack/thread", requireAuth, async (req, res) => {
  console.log(`[CALL] /slack/thread by ${req.identity?.user} (${req.identity?.user_id})`);
  const { channel, ts } = req.query;
  const limit = String(req.query.limit || 100);
  if (!channel || !ts) return res.status(400).json({ error: "missing channel or ts" });
  const resp = await fetch("https://slack.com/api/conversations.replies", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${req.slackUserToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ channel, ts, limit })
  }).then(r => r.json());
  return res.json(resp);
});

// ---------- ADMIN: who's authorized (optional) ----------
app.get("/admin/users", async (req, res) => {
  if (!ADMIN_KEY || (req.headers["x-admin-key"] || "") !== ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (redis) {
    const keys = await redis.smembers("users:index");
    const users = [];
    for (const k of keys) {
      const h = await redis.hgetall(k);
      if (h) users.push(h);
    }
    return res.json({ users, persistent: true });
  }
  return res.json({ users: Array.from(USERS.values()), persistent: false });
});

// ---------- DEBUG: Firebase connectivity test ----------
app.get("/debug/firebase", async (req, res) => {
  if (!ADMIN_KEY || (req.headers["x-admin-key"] || "") !== ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  
  const debugInfo = {
    firebaseConfigured: !!(FIREBASE_PROJECT_ID && FIREBASE_PRIVATE_KEY && FIREBASE_CLIENT_EMAIL),
    firestoreInitialized: !!firestore,
    projectId: FIREBASE_PROJECT_ID || 'not set',
    clientEmail: FIREBASE_CLIENT_EMAIL || 'not set',
    privateKeySet: !!FIREBASE_PRIVATE_KEY
  };
  
  if (firestore) {
    try {
      // Test Firestore connectivity
      const testDoc = await firestore.collection('_debug').doc('connectivity-test').set({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        test: true
      });
      
      debugInfo.connectivityTest = 'success';
      debugInfo.testDocId = 'connectivity-test';
      
      // Clean up test doc
      await firestore.collection('_debug').doc('connectivity-test').delete();
      
    } catch (error) {
      debugInfo.connectivityTest = 'failed';
      debugInfo.error = error.message;
    }
  }
  
  return res.json(debugInfo);
});

// ---------- HEALTH ----------
app.get("/", (_, res) => res.send("OK"));

// ---------- RUN ----------
app.listen(PORT || 3000, () => console.log("proxy up"));
