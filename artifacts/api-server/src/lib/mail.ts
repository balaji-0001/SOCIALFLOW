import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

/*
 * Outgoing email (currently only password-reset links).
 *
 * Real delivery needs an SMTP account: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM
 * (SMTP_SECURE=true for port 465). Any provider works (Gmail app password, Resend/SendGrid/Mailgun SMTP, ...).
 *
 * For local development only, MAIL_TRANSPORT=log prints the email to the server log instead of sending it.
 * It is an explicit opt-in and is refused in production, so a misconfigured server can never look like it sent mail.
 */

export type MailMode = "smtp" | "log" | "off";

export function mailMode(env: NodeJS.ProcessEnv = process.env): MailMode {
  if (env.MAIL_TRANSPORT?.trim() === "log" && env.NODE_ENV !== "production") return "log";
  if (env.SMTP_HOST?.trim() && env.MAIL_FROM?.trim()) return "smtp";
  return "off";
}

export type MailAttachment = { filename: string; content: Buffer; contentType?: string };
export type Mail = { to: string; subject: string; text: string; attachments?: MailAttachment[] };

let transporter: Transporter | null = null;

function smtpTransport(): Transporter {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

/** Sends (or, in log mode, prints) an email. Throws if delivery fails. */
export async function sendMail(mail: Mail): Promise<void> {
  const mode = mailMode();
  if (mode === "off") throw new Error("Email is not configured.");
  if (mode === "log") {
    logger.warn({ to: mail.to, subject: mail.subject }, `MAIL_TRANSPORT=log: email not sent, content follows\n${mail.text}`);
    return;
  }
  await smtpTransport().sendMail({ from: process.env.MAIL_FROM!.trim(), to: mail.to, subject: mail.subject, text: mail.text, attachments: mail.attachments });
}
