# Forgot password

The sign-in page has a **Forgot password?** link. The user enters their email and, if an account exists, the server emails a link to `/reset-password?token=...`. The link works once and expires after one hour. On that page they choose a new password, are signed out everywhere, and sign in with the new one.

## Setup: email must be configured

Real delivery needs an SMTP account. Set these in `.env` and restart the API:

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587          # 465 also works (secure)
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM="Socialflow <no-reply@yourdomain.com>"
```

Without these the form says "Password reset by email isn't set up on this server yet." It never pretends an email was sent. For local testing only, `MAIL_TRANSPORT=log` prints the email (with the link) to the API server's log instead of sending it; it is refused when `NODE_ENV=production`.

The link's address comes from `OAUTH_REDIRECT_BASE_URL`, so it must be the public address users reach the site at (with a free tunnel it changes when the tunnel restarts).

## Behaviour and safeguards

- Same response whether or not the email is registered (no account discovery). Only "email isn't configured" and "couldn't send" are reported.
- Tokens are 256-bit random; only their SHA-256 hash is stored. Single use, 1 hour, a newer request replaces older links.
- Limits: 10 requests/hour per IP, 1 email/minute per account, 20 reset attempts/hour per IP.
- Resetting deletes all of the account's sessions.
- Code: `api-server/src/routes/auth.ts`, `lib/mail.ts`, table `socialflow_password_resets`.
