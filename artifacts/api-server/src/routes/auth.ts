import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, passwordResetsTable, sessionsTable, usersTable, workspaceMembersTable, workspacesTable, type User } from "@workspace/db";
import { jsonError } from "../lib/http-errors";
import { hashPassword, isPasswordStrongEnough, normalizeEmail, verifyPassword } from "../lib/password";
import { mailMode, sendMail } from "../lib/mail";
import { getRedirectBaseUrl } from "../lib/oauth/config";
import { ROLE_PERMISSIONS } from "../lib/permissions";
import { clearSession, createSession, resolveWorkspace } from "../lib/session";
import { rateLimit } from "../middlewares/rate-limit";

const router: IRouter = Router();

// Credential stuffing / signup-spam protection. Keyed by client IP; see
// middlewares/rate-limit.ts for the (single-process, in-memory) design.
// Limits are env-overridable so the test suite (which creates many
// accounts from one IP within a single process) can raise them without
// weakening the production defaults or special-casing NODE_ENV inside the
// limiter itself.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_LOGIN_RATE_LIMIT ?? 20),
  keyPrefix: "auth:login",
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.AUTH_SIGNUP_RATE_LIMIT ?? 10),
  keyPrefix: "auth:signup",
});

// Reset requests send email, so they get their own, tighter limit: per IP here, and per account below.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.AUTH_FORGOT_RATE_LIMIT ?? 10),
  keyPrefix: "auth:forgot",
});
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.AUTH_RESET_RATE_LIMIT ?? 20),
  keyPrefix: "auth:reset",
});
const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Computed once at startup so login always does a real scrypt comparison,
// even when the email doesn't match any account. Without this, the time a
// login request takes would reveal whether the email exists.
const unknownEmailComparisonHash = await hashPassword(`unused-${Math.random()}`);

function serializeUser(user: Pick<User, "id" | "email" | "displayName">) {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

router.post("/auth/signup", signupLimiter, async (req, res): Promise<void> => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const displayNameRaw = req.body?.displayName;
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim().length > 0
      ? displayNameRaw.trim().slice(0, 200)
      : null;

  if (!email) return jsonError(res, 400, "invalid_email", "Enter a valid email address.");
  if (!isPasswordStrongEnough(password)) {
    return jsonError(res, 400, "weak_password", "Password must be between 8 and 256 characters.");
  }

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) return jsonError(res, 409, "email_taken", "An account with this email already exists.");

  const passwordHash = await hashPassword(password);

  const created = await db.transaction(async (tx) => {
    const [user] = await tx.insert(usersTable).values({ email, passwordHash, displayName }).returning();
    const [workspace] = await tx
      .insert(workspacesTable)
      .values({ name: displayName ? `${displayName}'s workspace` : "My workspace", ownerUserId: user!.id })
      .returning();
    await tx.insert(workspaceMembersTable).values({ workspaceId: workspace!.id, userId: user!.id, role: "owner" });
    return { user: user!, workspace: workspace! };
  });

  await createSession(req, res, created.user.id);
  req.log.info({ userId: created.user.id }, "User signed up");
  res.status(201).json({ user: serializeUser(created.user), workspace: { id: created.workspace.id, name: created.workspace.name } });
});

router.post("/auth/login", loginLimiter, async (req, res): Promise<void> => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;

  if (!email || typeof password !== "string") {
    return jsonError(res, 401, "invalid_credentials", "Incorrect email or password.");
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  // Always run a real scrypt comparison, whether or not the user exists, so
  // response time doesn't leak which emails are registered.
  const valid = await verifyPassword(password, user?.passwordHash ?? unknownEmailComparisonHash);
  if (!user || !valid) {
    return jsonError(res, 401, "invalid_credentials", "Incorrect email or password.");
  }

  await createSession(req, res, user.id);
  req.log.info({ userId: user.id }, "User signed in");
  res.json({ user: serializeUser(user) });
});

/**
 * Starts a password reset: emails a single-use link (valid for an hour) to the address if it belongs to an account.
 * The response is the same whether or not the address is registered, so this can't be used to find out who has an
 * account. It does say so when the server can't send email at all, since that is a server setting, not account data.
 */
router.post("/auth/forgot-password", forgotLimiter, async (req, res): Promise<void> => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return jsonError(res, 400, "invalid_email", "Enter a valid email address.");
  const base = getRedirectBaseUrl();
  if (mailMode() === "off" || !base) {
    return jsonError(res, 503, "email_not_configured", "Password reset by email isn't set up on this server yet. Ask the administrator to configure email.");
  }

  const generic = { message: "If an account exists for that email, we've sent a link to reset the password. It works for one hour." };
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) return void res.json(generic);

  // One email per minute per account, so the form can't be used to flood someone's inbox.
  const [recent] = await db
    .select({ id: passwordResetsTable.id })
    .from(passwordResetsTable)
    .where(and(eq(passwordResetsTable.userId, user.id), gt(passwordResetsTable.createdAt, new Date(Date.now() - RESET_COOLDOWN_MS))))
    .limit(1);
  if (recent) return void res.json(generic);

  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.delete(passwordResetsTable).where(and(eq(passwordResetsTable.userId, user.id), isNull(passwordResetsTable.usedAt)));
    await tx.delete(passwordResetsTable).where(lt(passwordResetsTable.expiresAt, new Date()));
    await tx.insert(passwordResetsTable).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  });

  const link = `${base}/reset-password?token=${token}`;
  try {
    await sendMail({
      to: user.email,
      subject: "Reset your Socialflow password",
      text: [
        `Hi${user.displayName ? ` ${user.displayName}` : ""},`,
        "",
        "Someone asked to reset the password for your Socialflow account. Use this link to choose a new one (it works once, for one hour):",
        "",
        link,
        "",
        "If you didn't ask for this, you can ignore this email. Your password won't change.",
      ].join("\n"),
    });
  } catch (error) {
    // The link was never delivered, so it is worthless: remove it and tell the user honestly.
    await db.delete(passwordResetsTable).where(eq(passwordResetsTable.tokenHash, sha256(token)));
    req.log.error({ err: error, userId: user.id }, "Sending the password reset email failed");
    return jsonError(res, 502, "email_failed", "We couldn't send the email right now. Try again in a few minutes.");
  }
  req.log.info({ userId: user.id }, "Password reset requested");
  res.json(generic);
});

/** Sets a new password from an emailed link, then signs the account out everywhere. The user signs in with the new password. */
router.post("/auth/reset-password", resetLimiter, async (req, res): Promise<void> => {
  const token = req.body?.token;
  const password = req.body?.password;
  if (!isPasswordStrongEnough(password)) return jsonError(res, 400, "weak_password", "Password must be between 8 and 256 characters.");
  const invalid = () => jsonError(res, 400, "invalid_token", "This reset link is invalid or has expired. Request a new one.");
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return invalid();

  const passwordHash = await hashPassword(password);
  const done = await db.transaction(async (tx) => {
    // Claiming the link and using it are one statement, so a link can't be used twice even by two simultaneous requests.
    const [claimed] = await tx
      .update(passwordResetsTable)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetsTable.tokenHash, sha256(token)), isNull(passwordResetsTable.usedAt), gt(passwordResetsTable.expiresAt, new Date())))
      .returning({ userId: passwordResetsTable.userId });
    if (!claimed) return false;
    await tx.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, claimed.userId));
    await tx.delete(sessionsTable).where(eq(sessionsTable.userId, claimed.userId));
    await tx.delete(passwordResetsTable).where(and(eq(passwordResetsTable.userId, claimed.userId), isNull(passwordResetsTable.usedAt)));
    return true;
  });
  if (!done) return invalid();
  req.log.info("Password reset completed");
  res.json({ message: "Your password has been changed. Sign in with the new password." });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  await clearSession(req, res);
  res.sendStatus(204);
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) return jsonError(res, 401, "unauthorized", "Sign in to continue.");
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.userId)).limit(1);
  if (!user) return jsonError(res, 401, "unauthorized", "Sign in to continue.");
  const memberships = await db
    .select({ id: workspacesTable.id, name: workspacesTable.name, role: workspaceMembersTable.role })
    .from(workspaceMembersTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workspaceMembersTable.workspaceId))
    .where(eq(workspaceMembersTable.userId, ctx.userId))
    .orderBy(workspaceMembersTable.createdAt);
  const current = memberships.find((row) => row.id === ctx.workspaceId);
  res.json({
    user: serializeUser(user),
    workspaceId: ctx.workspaceId,
    workspace: { id: ctx.workspaceId, name: current?.name ?? "My workspace" },
    role: ctx.role,
    permissions: ROLE_PERMISSIONS[ctx.role],
    workspaces: memberships.map((row) => ({ id: row.id, name: row.name, role: row.role, current: row.id === ctx.workspaceId })),
  });
});

export default router;
