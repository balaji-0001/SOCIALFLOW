<?php
/**
 * Runs when the plugin is deleted from the Plugins screen: removes everything it stored.
 * SocialFlow is not told; replace or delete the automation there to withdraw the key.
 *
 * @package SocialFlowAutoShare
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'sfas_settings' );
delete_option( 'sfas_connection' );
delete_option( 'sfas_log' );
delete_transient( 'sfas_status' );
delete_post_meta_by_key( '_sfas_status' );
delete_post_meta_by_key( '_sfas_skip' );
wp_unschedule_hook( 'sfas_send_post' );
