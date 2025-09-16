import express from "express";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ----- CONFIG (from env) -----
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;          // make a long random string
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;         // 7 days

// ----- OAuth: ChatGPT will call our Token URL with the Slack "code" -----
app.post("/oauth/token", async (req, res) => {
  // ChatGPT sends: grant_type=authorization_code, code, redirect_uri
  const { code, redirect_uri } = req.body || {};
  if (!code || !redirect_uri) {
    return res.status(400).json({ error: "missing code or redirect_uri" });
  }

  // Exchange with Slack for a USER token (xoxp-…)
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

  const userToken = slackResp?.authed_user?.access_token;
  if (!slackResp.ok || !userToken) {
    return res.status(400).json({ error: "slack_oauth_failed", details: slackResp });
  }

  // Mint a JWT so ChatGPT never sees the raw Slack token
  const access_token = jwt.sign(
    { slack_user_token: userToken },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  );

  // Return a standard OAuth token payload
  return res.json({
    access_token,
    token_type: "bearer",
    expires_in: TOKEN_TTL_SECONDS
  });
});

// ----- Auth middleware: verify our JWT and extract Slack user token -----
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const decoded = jwt.verify(bearer, JWT_SECRET);
    req.slackUserToken = decoded.slack_user_token;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// ----- API that the GPT calls -----
app.get("/slack/search", requireAuth, async (req, res) => {
  const q = req.query.q || "";
  const count = String(req.query.limit || 50);
  const resp = await fetch("https://slack.com/api/search.messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${req.slackUserToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ query: q, count, highlight: "true" })
  }).then(r => r.json());
  res.json(resp);
});

app.get("/oauth/authorize", (req, res) => {
    const { redirect_uri, state } = req.query;
    const u = new URL("https://slack.com/oauth/v2/authorize");
    u.searchParams.set("client_id", SLACK_CLIENT_ID);
    u.searchParams.set("user_scope", "search:read,channels:history,groups:history,im:history,mpim:history");
    if (redirect_uri) u.searchParams.set("redirect_uri", redirect_uri);
    if (state) u.searchParams.set("state", state);
    res.redirect(u.toString());
  });
  

  
app.get("/slack/thread", requireAuth, async (req, res) => {
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
  res.json(resp);
});

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("proxy up"));
