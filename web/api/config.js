// Public settings the page needs: the Google client id for "Sign in with Google" (not a secret).
module.exports = function handler(req, res) {
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
};
