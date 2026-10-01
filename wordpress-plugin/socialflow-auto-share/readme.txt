=== SocialFlow Auto-Share ===
Requires at least: 5.8
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Sends each post you publish to SocialFlow, which posts it to your connected social accounts.

== Description ==

When a post is published on this site, the plugin sends its title, excerpt, link, featured image, author and time to
your SocialFlow workspace. SocialFlow creates the social post for the accounts you chose there and publishes it, adds
it to your queue, or saves it as a draft, whichever you set.

* A post is shared once. Editing it later, or unpublishing and publishing it again, does not share it a second time.
* If SocialFlow can't be reached, the plugin tries again after 1 minute, 5 minutes, 30 minutes and 2 hours.
* Every request is signed with your connection key. Once you have pasted it, the key's secret never leaves your site.
* Nothing is shared during an import, for password-protected posts, or for posts dated more than 3 days ago.
* Publishing many posts at once sends them a few seconds apart in the background instead of slowing the request down.
* The Posts list has a SocialFlow column with each post's status and a "Share now" link.

The accounts, the text of the social post and when it goes out are all set in SocialFlow, not here.

== Installation ==

1. In WordPress, go to Plugins > Add New Plugin > Upload Plugin, choose the zip file and activate the plugin.
2. In SocialFlow, open Automations, choose New automation, then WordPress plugin. Pick the accounts and create it.
3. Copy the connection key SocialFlow shows you. It is shown only once.
4. In WordPress, go to Settings > SocialFlow, paste the key and press Connect.

To stop sharing for a while, untick "Share posts automatically" on the same screen, or pause the automation in
SocialFlow. To disconnect for good, press Disconnect.

== Frequently Asked Questions ==

= A post was not shared. Why? =

Open Posts and look at the SocialFlow column. It says whether the post was shared, is waiting for another try, was
skipped (with the reason) or failed (with what SocialFlow answered). Use "Share now" under the post's title to send it.

= I lost the connection key. =

In SocialFlow, open the automation and create a new key. The old one stops working at once. Then press Disconnect
here and connect with the new key.

= Which posts are shared? =

Posts, by default. Pages and other public content types can be ticked under Settings > SocialFlow. While writing a
post you can untick "Share on social media" to leave that one out.

= For developers =

* `socialflow_auto_share_should_share` (bool, WP_Post): return false to keep a post from being shared automatically.
* `socialflow_auto_share_payload` (array, WP_Post): change what is sent for a post.
* `socialflow_auto_share_max_age` (seconds, WP_Post): how old a post's date may be and still be shared. 0 for no limit.

== Changelog ==

= 1.0.0 =
* First version.
