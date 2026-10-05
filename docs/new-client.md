# Setting SocialFlow up for another client

The same code serves every client. Nothing in it is specific to one: accounts, posts, automations and the team all belong to a workspace. There are two ways to give a new client their own SocialFlow, and the WordPress plugin works the same with both.

## Option A: a workspace on the installation you already run
Use this unless the client needs their own address or their own database.

1. The client signs up on your site. That creates their user and their own workspace. Nothing is shared with other workspaces.
2. They connect their social accounts on Connected Accounts.
3. They open Automations, choose New automation, then WordPress plugin, pick the accounts, and get a connection key.
4. On their WordPress site they install the plugin (the dialog has the download), open Settings > SocialFlow and paste the key.

What they share with your other clients: the address, the server and its limits, and your developer apps on Facebook, Instagram, LinkedIn and Google. Those apps must be approved for public use before people outside your tester lists can connect accounts (see `docs/task.md`, "Needs your action").

## Option B: a separate installation for the client
Use this when the client wants their own address, their own database, or their own developer apps. It is the same repository deployed a second time; do not copy the code.

1. **Database.** Create a new MySQL 8 database (`CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`) on any MySQL host; `mysql.md` lists options. The first start creates every table.
2. **API.** Create a second service from this repository (`render.yaml` describes it). Set its own values, never the first installation's:
   - `DATABASE_URL`: the new database.
   - `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`: new random values. Keep a copy of the encryption key; without it the stored social tokens can't be read.
   - `OAUTH_REDIRECT_BASE_URL`: the client's site address, without a trailing slash.
   - The app ids and secrets for each network (the client's own apps, or yours).
   - Mail settings if password reset and approval emails should work.
3. **Website.** Deploy the frontend a second time. Its `/api/*` requests must be forwarded to the new API: in `vercel.json` the `destination` of the `/api/:path*` rewrite names the API's address, so the second site needs that line pointing at the second API (a second Vercel project with its own copy of that one line, or the static site in `render.yaml`).
4. **Networks.** In each network's developer console add `<site address>/api/connections/<platform>/callback` as a redirect address. For Meta also set the data deletion callback to `<site address>/api/data-deletion/meta`.
5. **Keep it awake.** On a free plan the API sleeps without traffic, which stops scheduled posts and delays the plugin's posts until its next retry. Point an uptime monitor at `<site address>/api/healthz`, or use a plan that stays on.
6. Then follow Option A's steps on the new site.

## The WordPress plugin and the address
A connection key carries the address the plugin calls: the installation's public address (`OAUTH_REDIRECT_BASE_URL`). So:
- Set `OAUTH_REDIRECT_BASE_URL` to the address the client's WordPress site can reach before making keys. A key made on a development machine at `localhost` only works for a WordPress on that same machine.
- If the site later moves to another address, make a new key on the automation ("Plugin key") and connect the plugin again.
- One key connects one WordPress site. A client with several sites creates one plugin automation per site.

## What to check before handing over
- Sign up, connect one account, create a plugin automation with "Save as draft", connect the plugin, publish a test post in WordPress and see the draft appear in SocialFlow. Then switch the automation to the mode the client wants.
- In WordPress, Settings > SocialFlow shows "Connected" with the workspace and the accounts.
- The Posts list in WordPress shows "Shared" for the test post.
