// Vercel serverless function: POST /api/chat
// Keeps the Anthropic API key server-side (never exposed to the browser).
// Requires a valid Firebase ID token (from the site's own sign-in) in the
// "Authorization: Bearer <token>" header, so a stranger who finds the URL
// can't use this endpoint as a free, unmetered LLM proxy.
// Expects JSON body: { system: string, messages: [{role:"user"|"assistant", content:string}, ...] }
// Returns: { text: string }  or  { error: string } with a non-200 status.

import admin from "firebase-admin";

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

// Very small in-memory rate limiter: caps requests per signed-in user within
// a warm serverless instance. Not perfect across cold starts or multiple
// regions, but it stops a single session from hammering the endpoint.
const RATE_LIMIT = 30; // requests
const RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes
const rateLimitStore = globalThis.__accordRateLimit || (globalThis.__accordRateLimit = new Map());

function isRateLimited(uid) {
  const now = Date.now();
  const entry = rateLimitStore.get(uid);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitStore.set(uid, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project's Environment Variables." });
    return;
  }

  const fbAdmin = getFirebaseAdmin();
  if (!fbAdmin) {
    res.status(500).json({ error: "Server is missing FIREBASE_SERVICE_ACCOUNT. Set it in your Vercel project's Environment Variables." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }

  let uid;
  try {
    const decoded = await fbAdmin.auth().verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch (e) {
    res.status(401).json({ error: "Your session expired. Please sign in again." });
    return;
  }

  if (isRateLimited(uid)) {
    res.status(429).json({ error: "Too many requests — please wait a bit before asking again." });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { system, messages } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  // Basic guardrails so one browser tab can't run up a huge bill.
  const totalChars = (system || "").length + messages.reduce((n, m) => n + String(m.content || "").length, 0);
  if (totalChars > 60000) {
    res.status(400).json({ error: "That conversation got too long for one request." });
    return;
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: system || undefined,
        messages: messages.map((m) => ({ role: m.role, content: String(m.content || "") }))
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data?.error?.message || "The AI request failed." });
      return;
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      res.status(502).json({ error: "The AI returned no text." });
      return;
    }

    res.status(200).json({ text });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the AI service. Try again." });
  }
}
