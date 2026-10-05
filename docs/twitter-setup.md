# X (Twitter)

How to connect X accounts to SocialFlow, what it costs, and what is and isn't supported. In the code the network is called `twitter`; the interface calls it X.

## What works
- Connecting an X account (OAuth 2.0 with PKCE). One sign-in connects the one account that signed in.
- Publishing and scheduling posts: text, up to 4 photos, or one GIF, or one video.
- A first comment, posted as a reply under the post from the same account.
- Queues, recurring posts, approvals, the calendar, CSV import and automations (RSS, WordPress, the WordPress plugin), as for the other networks.
- A "view on X" link on each published post.

## What it costs
X has no free API plan. You buy credits in the X developer console and every call uses some. Prices on 5 October 2026, from [X's pricing page](https://docs.x.com/x-api/getting-started/pricing); check it before relying on them:

| What SocialFlow does | X's price |
|---|---|
| Publish a post | $0.015 |
| Publish a post that contains a link | $0.20 |
| Post a first comment (a reply) | $0.015, or $0.20 with a link |
| Check a connected account ("Verify") | about $0.001 to $0.01 |
| Read a post's numbers (only if analytics is switched on, see below) | $0.001 per post per day |

A post with a link costs thirteen times a post without one. Automations and the WordPress plugin put the article's link in every post, so each of those is a $0.20 post on X.

When the credits run out X refuses the request; the post is marked failed with X's reason and can be retried after topping up. Nothing is retried automatically.

## Setting up the developer app
1. Go to the X developer console (console.x.com) with the X account that will own the app, create a project and an app, and buy some credits.
2. In the app's **User authentication settings**:
   - App permissions: **Read and write**.
   - Type of App: **Web App, Automated App or Bot** (a confidential client).
   - Callback URI: `<your site>/api/connections/twitter/callback`, exactly as `GET /api/connections/providers` prints it (`callbackUrl`). X requires an exact match, so add one for each address you use (the live site, and the tunnel address while testing locally).
   - Website URL: your site.
3. Under **Keys and tokens**, copy the **OAuth 2.0 Client ID** and **Client Secret** (not the API key and secret, which are for the older OAuth 1.0a).
4. Set them on the API and restart it:
   ```
   TWITTER_CLIENT_ID=...
   TWITTER_CLIENT_SECRET=...
   ```
5. Open **Connected accounts** in SocialFlow. The X card now says **Connect account**.

The permissions requested are `tweet.read`, `tweet.write`, `users.read`, `media.write` and `offline.access` (the last one lets SocialFlow keep the account connected without asking again).

## Rules SocialFlow applies
- **Length.** X allows 280 and counts its own way: every link counts as 23 whatever its length, most alphabets count 1 per character, and Chinese, Japanese, Korean and emoji count 2. The composer shows X's count. A post that doesn't fit is refused when it is scheduled or published; write a shorter version for X with "Customize per network". Longer posts for X Premium accounts are not supported.
- **Media.** Up to 4 photos (JPG, PNG or WebP, 5 MB each), or one GIF (15 MB), or one video (MP4 or MOV). Photos and video can't be mixed.
- **Links.** X builds the link card itself from the page's own tags, so a title or picture edited in the composer doesn't apply there. If a link is attached but not written in the text, it is added at the end.
- **Refused posts.** X refuses a post that repeats an earlier one word for word. The post is marked failed with X's reason; the account stays connected.

## Not supported
- **Inbox.** Replies, direct messages and mentions from X are not read. The Inbox says so for X accounts.
- **Analytics by default.** Reading numbers costs credits on every reading, so it is off. Set `TWITTER_ANALYTICS_ENABLED=true` to collect followers and, per post, likes, replies, reposts and quotes (shown as shares), impressions and bookmarks (shown as saves). X doesn't report reach; its "views" are the impressions. With the switch off, the analytics page shows X's numbers as unavailable and says why.
- Threads, polls, quote posts and editing a published post.

## How tokens are handled
An X access token lasts two hours. SocialFlow refreshes it when needed. X gives a new refresh token with every refresh and retires the old one, so refreshes of one account never run at the same time (`ensureFreshToken` in `lib/oauth/accounts.ts`); this holds within one API process. If X no longer accepts the refresh token (access was removed in X's settings, or the account wasn't used for six months), the account shows **Reconnect**.

## Files
`lib/oauth/providers/twitter.ts` (the adapter), `lib/twitter-text.ts` (X's way of counting, mirrored in `artifacts/socialflow/src/app/twitter-text.ts`), `lib/media-rules.ts`, `test/fake-twitter.ts`, and the tests `lib/twitter-text.test.ts`, `lib/oauth/providers/twitter.test.ts`, `routes/twitter.test.ts`.

## Not yet verified
Everything above is tested against a stand-in for X's API built from X's documentation. It has not been run against X itself: that needs a developer app with credits. The first real connection and the first real post should be checked by hand.
