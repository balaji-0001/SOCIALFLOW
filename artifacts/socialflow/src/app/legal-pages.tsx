import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import './legal.css';

/*
 * Privacy Policy, Terms of Service and Data Deletion instructions. Public pages (no sign-in), required by Meta, LinkedIn
 * and Google before an app can be made live. They describe what this app actually does; if the app's behaviour changes,
 * change the text with it. The wording is a plain-language starting point, not legal advice.
 */

export const CONTACT_EMAIL = 'balajibalu09@gmail.com';
const UPDATED = '30 September 2026';

function LegalShell({ title, intro, children, testid }: { title: string; intro: string; children: ReactNode; testid: string }) {
  return <div className="sfl-page" data-testid={testid}>
    <header className="sfl-top"><a href="/" className="sfl-back"><ArrowLeft size={15} aria-hidden /> SocialFlow</a>
      <nav aria-label="Legal pages"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/data-deletion">Data deletion</a></nav></header>
    <main className="sfl-doc">
      <h1>{title}</h1>
      <p className="sfl-meta">Last updated {UPDATED}</p>
      <p className="sfl-lead">{intro}</p>
      {children}
      <p className="sfl-contact">Questions about this page? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </main>
  </div>;
}

const H = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;

export function PrivacyPage() {
  return <LegalShell testid="page-privacy" title="Privacy Policy" intro="SocialFlow lets you plan, publish and measure posts on the social accounts you connect. This page explains what information we handle to do that, why, and the choices you have.">
    <H>What we collect</H>
    <ul>
      <li><strong>Your account:</strong> your email address, your name if you give one, and a password (stored only as a one-way hash, never in readable form).</li>
      <li><strong>Connected social accounts:</strong> when you connect Facebook Pages, Instagram, LinkedIn or YouTube we receive the account's name, ID, profile picture and an access token that lets SocialFlow act for that account. Tokens are stored encrypted.</li>
      <li><strong>Your content:</strong> the posts, drafts, schedules, photos and videos you create, the tags and library items you save, and the team members you invite.</li>
      <li><strong>Data from the networks, only for accounts you connect:</strong> post results, follower and engagement numbers (analytics), and, where you enable and the network allows it, comments and messages sent to your accounts so you can read and answer them in the Inbox.</li>
      <li><strong>Technical data:</strong> a sign-in cookie, and standard server logs (such as request time and status) used to keep the service working and secure.</li>
    </ul>
    <H>How we use it</H>
    <p>Only to provide SocialFlow to you: to publish and schedule your posts, show your analytics, deliver your Inbox, send you emails you ask for (password reset, team invitations, approval notices, scheduled reports), and to keep the service safe. We do not sell your information, use it for advertising, or use data received from Facebook, Instagram, LinkedIn or YouTube for anything other than these features.</p>
    <H>Information from Meta (Facebook and Instagram)</H>
    <p>When you connect a Facebook Page or Instagram professional account, SocialFlow requests only the permissions needed for the features you use: listing your Pages, publishing posts, and, if you turn them on, reading engagement and insights, comments and messages. This data is used only to show and manage your own accounts inside SocialFlow. It is not shared with anyone else, not sold, and not used to train models.</p>
    <H>AI Studio</H>
    <p>If AI Studio is enabled and you use it, the text you type into it (and the brand voice you choose) is sent to Anthropic to generate suggestions, and the result is shown to you. Nothing is sent unless you press generate.</p>
    <H>Who else handles data</H>
    <p>To run the service we rely on these providers, who process data on our behalf: <strong>Vercel</strong> (serves the website), <strong>Render</strong> (runs the application), <strong>Supabase</strong> (database, hosted in Singapore), an email provider (sends the emails above), <strong>Anthropic</strong> (only for AI Studio), and the social networks you connect. We do not give your information to anyone else, except where the law requires it.</p>
    <H>How long we keep it</H>
    <p>We keep your information while your account is active. Disconnecting a social account deletes its access token straight away. Uploaded files that are never attached to a post are removed automatically after about a day. You can ask us to delete everything at any time; see <a href="/data-deletion">Data deletion</a>.</p>
    <H>Security</H>
    <p>Access tokens are encrypted, passwords are hashed, connections use HTTPS, and each workspace can only see its own data. No system is perfectly secure, so please use a strong, unique password.</p>
    <H>Your choices</H>
    <ul>
      <li>Disconnect any social account in <em>Connected accounts</em>; you can also remove SocialFlow's access from inside Facebook, Instagram, LinkedIn or Google settings.</li>
      <li>Ask us to see, correct or delete your information by writing to the email below.</li>
      <li>SocialFlow is not intended for children under 13, and we do not knowingly collect their information.</li>
    </ul>
    <H>Changes</H>
    <p>If we change how we handle information we will update this page and its date.</p>
  </LegalShell>;
}

export function TermsPage() {
  return <LegalShell testid="page-terms" title="Terms of Service" intro="These terms apply when you use SocialFlow. By creating an account or connecting a social account you agree to them.">
    <H>The service</H>
    <p>SocialFlow is a tool for planning, publishing and measuring posts on social accounts you own or are authorised to manage. We may change or stop features, and some depend on approvals and limits set by the social networks, which we do not control.</p>
    <H>Your account</H>
    <ul>
      <li>You must give accurate information and keep your password private. You are responsible for what happens under your account, including what your team members do.</li>
      <li>You may only connect accounts you own or have permission to manage.</li>
    </ul>
    <H>Your content and conduct</H>
    <ul>
      <li>You own your content. You allow us to store it and send it to the networks you choose, only so the service can work.</li>
      <li>You are responsible for your posts and must follow the law and the rules of each network (Meta, LinkedIn, Google/YouTube). Do not post anything unlawful, deceptive, infringing or harmful, and do not use SocialFlow to send spam.</li>
      <li>Do not try to break, overload or gain unauthorised access to the service.</li>
    </ul>
    <H>Social networks</H>
    <p>Publishing, analytics and messages depend on each network's own services and permissions, and on your account staying connected. A network may reject a post, limit a feature or disconnect an account at any time. We are not responsible for a network's decisions or outages, and we cannot guarantee that a scheduled post will be published at the exact time.</p>
    <H>Availability</H>
    <p>We try to keep SocialFlow running but it is provided "as is" and "as available", without promises that it will be uninterrupted or error-free. Keep your own copy of anything important.</p>
    <H>Ending your use</H>
    <p>You can stop using SocialFlow and ask us to delete your data at any time (see <a href="/data-deletion">Data deletion</a>). We may suspend or close accounts that break these terms.</p>
    <H>Liability</H>
    <p>To the extent the law allows, we are not liable for indirect or consequential losses, or for lost posts, reach or revenue arising from your use of the service. Nothing here limits rights you have that cannot be limited by law.</p>
    <H>Changes</H>
    <p>We may update these terms; continuing to use SocialFlow after a change means you accept the new version. See also our <a href="/privacy">Privacy Policy</a>.</p>
  </LegalShell>;
}

export function DataDeletionPage() {
  return <LegalShell testid="page-data-deletion" title="Data deletion" intro="You can remove the connection between SocialFlow and your social accounts yourself, and you can ask us to delete everything we hold about you. Here is how.">
    <H>1. Remove a social account yourself (immediate)</H>
    <ol>
      <li>Sign in to SocialFlow and open <a href="/workspace">Connected accounts</a>.</li>
      <li>Choose the account (Facebook Page, Instagram, LinkedIn or YouTube) and select <strong>Disconnect</strong>.</li>
      <li>SocialFlow deletes that account's stored access token and its post records straight away, and can no longer act for it.</li>
    </ol>
    <p>You can also remove SocialFlow from the network itself: in Facebook go to <em>Settings → Business integrations</em> (or <em>Apps and websites</em>) and remove SocialFlow; in Instagram, <em>Settings → Website permissions → Apps and websites</em>; in LinkedIn, <em>Settings → Data privacy → Permitted services</em>; in Google, <em>Security → Third-party access</em>.</p>
    <H>2. Ask us to delete your account and all data</H>
    <p>Email <a href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20SocialFlow%20data`}>{CONTACT_EMAIL}</a> from the address you signed up with, with the subject <strong>Delete my SocialFlow data</strong>. If you signed in with Facebook or Instagram, mention that too. We will confirm the request and delete your account and everything linked to it.</p>
    <p>What is deleted: your sign-in details, your workspace and its posts, drafts, schedules, uploaded files, library items, tags, saved analytics numbers, inbox items, team invitations and connected-account tokens. Copies held in our hosting providers' routine backups are removed as those backups expire. We keep nothing that identifies you beyond what the law requires us to keep.</p>
    <H>3. What is not deleted</H>
    <p>Posts already published on Facebook, Instagram, LinkedIn or YouTube belong to those networks and to you. Deleting your SocialFlow data does not remove them; delete them on the network itself if you want them gone.</p>
  </LegalShell>;
}
