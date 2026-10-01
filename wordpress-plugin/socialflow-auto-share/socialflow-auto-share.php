<?php
/**
 * Plugin Name:       SocialFlow Auto-Share
 * Description:       Sends each post you publish to SocialFlow, which posts it to your connected social accounts.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            SocialFlow
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       socialflow-auto-share
 * Update URI:        false
 *
 * How it works
 * ------------
 * SocialFlow gives you a connection key. It holds SocialFlow's address, a key id and a secret. Pasting it under
 * Settings > SocialFlow connects this site. From then on, when a post is published, the plugin sends its title,
 * excerpt, link, featured image, author and time to SocialFlow, which creates the social post for the accounts chosen
 * there. Every request is signed with the secret (HMAC-SHA256 over the time and the body), so the secret itself is
 * never sent again.
 *
 * A post is sent once. The plugin remembers what it has sent, and SocialFlow refuses a post it already has, so
 * retries, a second save or publishing a post again never post it twice.
 *
 * @package SocialFlowAutoShare
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class SocialFlow_Auto_Share {

	const VERSION      = '1.0.0';
	const SLUG         = 'socialflow-auto-share';
	const OPT_SETTINGS = 'sfas_settings';
	const OPT_CONN     = 'sfas_connection';
	const OPT_LOG      = 'sfas_log';
	const META_STATUS  = '_sfas_status';
	const META_SKIP    = '_sfas_skip';
	const CRON_HOOK    = 'sfas_send_post';
	const KEY_PREFIX   = 'sfwp1_';
	const LOG_SIZE     = 20;
	const MAX_ATTEMPTS = 5;

	/** Seconds to wait before attempts 2, 3, 4 and 5 when SocialFlow can't be reached. */
	private static $retry_delays = array( 60, 300, 1800, 7200 );

	/** Posts that became published during this request, handled when the request ends. */
	private static $pending = array();

	public static function init() {
		add_action( 'init', array( __CLASS__, 'register_meta' ) );
		add_action( 'transition_post_status', array( __CLASS__, 'on_transition' ), 10, 3 );
		add_action( 'shutdown', array( __CLASS__, 'on_shutdown' ) );
		add_action( self::CRON_HOOK, array( __CLASS__, 'on_cron' ), 10, 2 );

		if ( is_admin() ) {
			add_action( 'admin_menu', array( __CLASS__, 'admin_menu' ) );
			add_action( 'admin_init', array( __CLASS__, 'admin_columns' ) );
			add_action( 'admin_notices', array( __CLASS__, 'admin_notices' ) );
			add_action( 'admin_post_sfas_connect', array( __CLASS__, 'handle_connect' ) );
			add_action( 'admin_post_sfas_disconnect', array( __CLASS__, 'handle_disconnect' ) );
			add_action( 'admin_post_sfas_save', array( __CLASS__, 'handle_save' ) );
			add_action( 'admin_post_sfas_share', array( __CLASS__, 'handle_share' ) );
			add_action( 'add_meta_boxes', array( __CLASS__, 'add_meta_box' ) );
			add_action( 'save_post', array( __CLASS__, 'save_meta_box' ) );
			add_action( 'enqueue_block_editor_assets', array( __CLASS__, 'editor_assets' ) );
			add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'action_links' ) );
			add_filter( 'post_row_actions', array( __CLASS__, 'row_actions' ), 10, 2 );
			add_filter( 'page_row_actions', array( __CLASS__, 'row_actions' ), 10, 2 );
		}
	}

	public static function on_activate() {
		if ( false === get_option( self::OPT_SETTINGS ) ) {
			add_option( self::OPT_SETTINGS, self::default_settings() );
		}
	}

	public static function on_deactivate() {
		wp_unschedule_hook( self::CRON_HOOK );
	}

	/* ---------------------------------------------------------------------
	 * Settings and connection
	 * ------------------------------------------------------------------- */

	private static function default_settings() {
		return array(
			'enabled'    => 1,
			'post_types' => array( 'post' ),
		);
	}

	public static function settings() {
		$saved = get_option( self::OPT_SETTINGS );
		$saved = is_array( $saved ) ? $saved : array();
		$types = isset( $saved['post_types'] ) && is_array( $saved['post_types'] ) ? array_values( array_filter( array_map( 'sanitize_key', $saved['post_types'] ) ) ) : array( 'post' );
		return array(
			'enabled'    => empty( $saved ) ? 1 : ( empty( $saved['enabled'] ) ? 0 : 1 ),
			'post_types' => $types,
		);
	}

	/** The public post types an admin can choose from (attachments are never shared). */
	private static function available_post_types() {
		$types = get_post_types( array( 'public' => true ), 'objects' );
		unset( $types['attachment'] );
		return $types;
	}

	/** The saved connection, or null. Holds the secret: never print it. */
	private static function connection() {
		$conn = get_option( self::OPT_CONN );
		if ( ! is_array( $conn ) || empty( $conn['api'] ) || empty( $conn['key_id'] ) || empty( $conn['secret'] ) ) {
			return null;
		}
		return $conn;
	}

	private static function save_connection( array $conn ) {
		if ( false === get_option( self::OPT_CONN ) ) {
			add_option( self::OPT_CONN, $conn, '', 'no' );
		} else {
			update_option( self::OPT_CONN, $conn, 'no' );
		}
	}

	/** Splits a connection key into SocialFlow's address, the key id and the secret. Null when it isn't one. */
	private static function parse_key( $raw ) {
		$raw = preg_replace( '/\s+/', '', (string) $raw );
		if ( 0 !== strpos( $raw, self::KEY_PREFIX ) ) {
			return null;
		}
		$encoded = strtr( substr( $raw, strlen( self::KEY_PREFIX ) ), '-_', '+/' );
		$encoded .= str_repeat( '=', ( 4 - strlen( $encoded ) % 4 ) % 4 );
		$decoded  = base64_decode( $encoded, true );
		if ( false === $decoded ) {
			return null;
		}
		$parts = explode( "\n", $decoded );
		if ( 3 !== count( $parts ) ) {
			return null;
		}
		$api = untrailingslashit( esc_url_raw( $parts[0], array( 'http', 'https' ) ) );
		if ( '' === $api || ! preg_match( '/^wpk_[0-9a-f]{24}$/', $parts[1] ) || strlen( $parts[2] ) < 20 ) {
			return null;
		}
		return array(
			'api'    => $api,
			'key_id' => $parts[1],
			'secret' => $parts[2],
		);
	}

	private static function site_info() {
		return array(
			'url'           => home_url(),
			'name'          => wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ),
			'wpVersion'     => get_bloginfo( 'version' ),
			'pluginVersion' => self::VERSION,
		);
	}

	/* ---------------------------------------------------------------------
	 * Talking to SocialFlow
	 * ------------------------------------------------------------------- */

	/**
	 * One signed request. Returns array( 'code' => int, 'data' => array ) or a WP_Error when SocialFlow wasn't reached.
	 *
	 * @param string     $path    connect, status, posts or disconnect.
	 * @param array      $body    Sent as JSON. The signature covers exactly these bytes.
	 * @param int        $timeout Seconds.
	 * @param array|null $conn    Credentials to use instead of the saved connection (while connecting).
	 */
	private static function request( $path, array $body, $timeout = 15, $conn = null ) {
		$conn = $conn ? $conn : self::connection();
		if ( ! $conn ) {
			return new WP_Error( 'sfas_not_connected', __( 'This site is not connected to SocialFlow.', 'socialflow-auto-share' ) );
		}
		$json      = wp_json_encode( empty( $body ) ? new stdClass() : $body );
		$timestamp = (string) time();
		$response  = wp_remote_post(
			$conn['api'] . '/wordpress-plugin/' . $path,
			array(
				'timeout'     => $timeout,
				'redirection' => 0,
				'headers'     => array(
					'Content-Type'           => 'application/json',
					'Accept'                 => 'application/json',
					'X-SocialFlow-Key'       => $conn['key_id'],
					'X-SocialFlow-Timestamp' => $timestamp,
					'X-SocialFlow-Signature' => 'v1=' . hash_hmac( 'sha256', $timestamp . '.' . $json, $conn['secret'] ),
				),
				'body'        => $json,
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$data = json_decode( wp_remote_retrieve_body( $response ), true );
		return array(
			'code' => (int) wp_remote_retrieve_response_code( $response ),
			'data' => is_array( $data ) ? $data : array(),
		);
	}

	/** SocialFlow's own words for a refusal, or a plain fallback. */
	private static function message_of( $result, $fallback ) {
		if ( is_wp_error( $result ) ) {
			/* translators: %s: the technical reason, such as a timeout. */
			return sprintf( __( 'SocialFlow could not be reached (%s).', 'socialflow-auto-share' ), $result->get_error_message() );
		}
		if ( ! empty( $result['data']['message'] ) && is_string( $result['data']['message'] ) ) {
			return $result['data']['message'];
		}
		/* translators: %d: HTTP status code. */
		return $fallback . ' ' . sprintf( __( '(SocialFlow answered %d.)', 'socialflow-auto-share' ), isset( $result['code'] ) ? $result['code'] : 0 );
	}

	/** True when the answer means this key will never work again, so retrying is pointless. */
	private static function is_cut_off( $result ) {
		return ! is_wp_error( $result ) && in_array( $result['code'], array( 401, 409 ), true )
			&& isset( $result['data']['error'] ) && in_array( $result['data']['error'], array( 'unknown_key', 'not_connected' ), true );
	}

	/* ---------------------------------------------------------------------
	 * Publishing: decide, send, retry
	 * ------------------------------------------------------------------- */

	public static function on_transition( $new_status, $old_status, $post ) {
		if ( 'publish' !== $new_status || 'publish' === $old_status || ! ( $post instanceof WP_Post ) ) {
			return;
		}
		// Decided when the request ends: by then the featured image and the "don't share" choice have been saved too.
		self::$pending[ $post->ID ] = true;
	}

	public static function on_shutdown() {
		if ( empty( self::$pending ) ) {
			return;
		}
		$ids           = array_keys( self::$pending );
		self::$pending = array();
		$todo          = array();
		foreach ( $ids as $post_id ) {
			$reason = self::reason_not_to_share( $post_id );
			if ( null === $reason ) {
				self::set_status( $post_id, 'queued', __( 'Waiting to be sent to SocialFlow.', 'socialflow-auto-share' ) );
				$todo[] = $post_id;
			} elseif ( '' !== $reason ) {
				self::set_status( $post_id, 'skipped', $reason );
				self::log( $post_id, 'skipped', $reason );
			}
		}
		if ( empty( $todo ) ) {
			return;
		}
		// A bulk publish is handed to WP-Cron, a few seconds apart, instead of holding this request for every post.
		if ( count( $todo ) > 3 ) {
			foreach ( $todo as $index => $post_id ) {
				wp_schedule_single_event( time() + 5 * ( $index + 1 ), self::CRON_HOOK, array( (int) $post_id, 1 ) );
			}
			return;
		}
		// Where the server can, the visitor gets the page first; the editor then never waits for SocialFlow.
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		} elseif ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		}
		foreach ( $todo as $post_id ) {
			self::send( $post_id, 1, false );
		}
	}

	public static function on_cron( $post_id, $attempt ) {
		self::send( (int) $post_id, max( 1, (int) $attempt ), false );
	}

	/**
	 * Why a newly published post is not shared automatically.
	 * null = share it; '' = not ours to share, say nothing; any other text = skipped, and that is why.
	 */
	private static function reason_not_to_share( $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post || 'publish' !== $post->post_status ) {
			return '';
		}
		$settings = self::settings();
		if ( ! in_array( $post->post_type, $settings['post_types'], true ) || ! self::connection() ) {
			return '';
		}
		// An import would publish a whole archive at once.
		if ( defined( 'WP_IMPORTING' ) && WP_IMPORTING ) {
			return '';
		}
		$status = get_post_meta( $post_id, self::META_STATUS, true );
		if ( is_array( $status ) && isset( $status['state'] ) && 'sent' === $status['state'] ) {
			return '';
		}
		if ( ! $settings['enabled'] ) {
			return __( 'Automatic sharing was switched off when this was published.', 'socialflow-auto-share' );
		}
		if ( get_post_meta( $post_id, self::META_SKIP, true ) ) {
			return __( 'Not shared: "share on social media" was unticked for this post.', 'socialflow-auto-share' );
		}
		if ( '' !== $post->post_password ) {
			return __( 'Not shared: the post is password protected.', 'socialflow-auto-share' );
		}
		/**
		 * How old (in seconds) a post's date may be and still be shared automatically. Older posts are usually
		 * back-dated or restored, not news. Return 0 for no limit.
		 */
		$max_age   = (int) apply_filters( 'socialflow_auto_share_max_age', 3 * DAY_IN_SECONDS, $post );
		$published = strtotime( $post->post_date_gmt . ' GMT' );
		if ( $max_age > 0 && $published && $published < time() - $max_age ) {
			return __( 'Not shared automatically: the post is dated more than 3 days ago. Use "Share now" to share it anyway.', 'socialflow-auto-share' );
		}
		/** Return false to keep a post from being shared automatically. */
		if ( ! apply_filters( 'socialflow_auto_share_should_share', true, $post ) ) {
			return __( 'Not shared: excluded by this site.', 'socialflow-auto-share' );
		}
		return null;
	}

	/** What SocialFlow is told about a post. Plain text only. */
	private static function payload( WP_Post $post ) {
		$thumbnail = get_post_thumbnail_id( $post );
		$image     = $thumbnail ? wp_get_attachment_image_src( $thumbnail, 'large' ) : false;
		$author    = get_userdata( (int) $post->post_author );
		$gmt       = $post->post_date_gmt;
		$payload   = array(
			'id'          => (int) $post->ID,
			'guid'        => get_the_guid( $post ),
			'title'       => self::plain( $post->post_title ),
			'excerpt'     => self::excerpt( $post ),
			'url'         => get_permalink( $post ),
			'imageUrl'    => $image ? $image[0] : null,
			'author'      => $author ? self::plain( $author->display_name ) : null,
			'publishedAt' => ( $gmt && '0000-00-00 00:00:00' !== $gmt ) ? str_replace( ' ', 'T', $gmt ) . 'Z' : gmdate( 'Y-m-d\TH:i:s\Z' ),
		);
		/** Change what is sent to SocialFlow for a post. */
		return (array) apply_filters( 'socialflow_auto_share_payload', $payload, $post );
	}

	private static function plain( $text ) {
		$text = wp_strip_all_tags( (string) $text, true );
		return trim( html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
	}

	private static function excerpt( WP_Post $post ) {
		$text = $post->post_excerpt;
		if ( '' === trim( $text ) ) {
			$text = $post->post_content;
			if ( function_exists( 'excerpt_remove_blocks' ) ) {
				$text = excerpt_remove_blocks( $text );
			}
			$text = strip_shortcodes( $text );
		}
		// Keep a space where a paragraph, line or list item ends, so two of them don't run together once the tags go.
		$text = preg_replace( '#<(?:br\s*/?|/(?:p|div|li|h[1-6]|blockquote|tr|td|figcaption))\s*>#i', '$0 ', (string) $text );
		return wp_trim_words( self::plain( $text ), 55, '...' );
	}

	/**
	 * Sends one post and records what happened. When SocialFlow can't be reached it is tried again later, a few
	 * times; a refusal that won't change by itself is not retried.
	 *
	 * @param int  $post_id Post.
	 * @param int  $attempt 1 for the first try.
	 * @param bool $manual  Someone pressed "Share now": no automatic retry, and SocialFlow lifts its attempt limit.
	 * @return array array( state, message )
	 */
	private static function send( $post_id, $attempt, $manual ) {
		$post = get_post( $post_id );
		if ( ! $post || 'publish' !== $post->post_status ) {
			return array( 'skipped', __( 'The post is no longer published.', 'socialflow-auto-share' ) );
		}
		$body = array( 'post' => self::payload( $post ) );
		if ( $manual ) {
			$body['manual'] = true;
		}
		// The first automatic try runs while the publish request is ending, so it gets less time than a retry.
		$timeout = $manual ? 20 : ( 1 === $attempt ? 8 : 25 );
		$result  = self::request( 'posts', $body, $timeout );

		if ( ! is_wp_error( $result ) && 200 === $result['code'] && isset( $result['data']['result'] ) ) {
			$message = isset( $result['data']['message'] ) && is_string( $result['data']['message'] ) ? $result['data']['message'] : '';
			switch ( $result['data']['result'] ) {
				case 'created':
				case 'duplicate':
					$state = 'sent';
					break;
				case 'skipped':
					$state = 'skipped';
					break;
				default:
					$state = 'failed';
			}
			return self::finish( $post_id, $state, $message, $attempt );
		}

		if ( self::is_cut_off( $result ) ) {
			$message = self::message_of( $result, __( 'The connection to SocialFlow is no longer valid.', 'socialflow-auto-share' ) );
			self::flag_problem( $message );
			return self::finish( $post_id, 'failed', $message, $attempt );
		}

		$unreachable = is_wp_error( $result ) || $result['code'] >= 500 || 429 === $result['code'] || 0 === $result['code'];
		$message     = self::message_of( $result, __( 'SocialFlow did not accept the post.', 'socialflow-auto-share' ) );
		if ( $unreachable && ! $manual && $attempt < self::MAX_ATTEMPTS ) {
			$delay = self::$retry_delays[ min( $attempt, count( self::$retry_delays ) ) - 1 ];
			wp_schedule_single_event( time() + $delay, self::CRON_HOOK, array( (int) $post_id, $attempt + 1 ) );
			/* translators: 1: why it failed, 2: a duration such as "5 mins". */
			$message = sprintf( __( '%1$s Trying again in %2$s.', 'socialflow-auto-share' ), $message, human_time_diff( time(), time() + $delay ) );
			self::set_status( $post_id, 'queued', $message, $attempt );
			self::log( $post_id, 'queued', $message );
			return array( 'queued', $message );
		}
		return self::finish( $post_id, 'failed', $message, $attempt );
	}

	private static function finish( $post_id, $state, $message, $attempt ) {
		self::set_status( $post_id, $state, $message, $attempt );
		self::log( $post_id, $state, $message );
		return array( $state, $message );
	}

	private static function set_status( $post_id, $state, $message, $attempt = 0 ) {
		update_post_meta(
			$post_id,
			self::META_STATUS,
			array(
				'state'    => $state,
				'message'  => wp_strip_all_tags( (string) $message ),
				'time'     => time(),
				'attempts' => (int) $attempt,
			)
		);
	}

	private static function log( $post_id, $state, $message ) {
		$log = get_option( self::OPT_LOG );
		$log = is_array( $log ) ? $log : array();
		array_unshift(
			$log,
			array(
				'time'    => time(),
				'post'    => (int) $post_id,
				'title'   => self::plain( get_the_title( $post_id ) ),
				'state'   => $state,
				'message' => wp_strip_all_tags( (string) $message ),
			)
		);
		$log = array_slice( $log, 0, self::LOG_SIZE );
		if ( false === get_option( self::OPT_LOG ) ) {
			add_option( self::OPT_LOG, $log, '', 'no' );
		} else {
			update_option( self::OPT_LOG, $log, 'no' );
		}
	}

	/** Remembers that SocialFlow turned this site away, so the admin is told once and clearly. */
	private static function flag_problem( $message ) {
		$conn = self::connection();
		if ( $conn ) {
			$conn['problem'] = wp_strip_all_tags( (string) $message );
			self::save_connection( $conn );
		}
	}

	/* ---------------------------------------------------------------------
	 * Admin: actions
	 * ------------------------------------------------------------------- */

	private static function settings_url() {
		return admin_url( 'options-general.php?page=' . self::SLUG );
	}

	/** A message for the next admin page this user loads. */
	private static function notify( $type, $message ) {
		set_transient(
			'sfas_notice_' . get_current_user_id(),
			array(
				'type'    => $type,
				'message' => $message,
			),
			60
		);
	}

	private static function guard( $nonce_action, $capability = 'manage_options', $object_id = null ) {
		$allowed = null === $object_id ? current_user_can( $capability ) : current_user_can( $capability, $object_id );
		if ( ! $allowed ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'socialflow-auto-share' ), 403 );
		}
		check_admin_referer( $nonce_action );
	}

	public static function handle_connect() {
		self::guard( 'sfas_connect' );
		$raw   = isset( $_POST['sfas_key'] ) ? sanitize_textarea_field( wp_unslash( $_POST['sfas_key'] ) ) : '';
		$creds = self::parse_key( $raw );
		if ( ! $creds ) {
			self::notify( 'error', __( 'That is not a SocialFlow connection key. Copy the whole key from SocialFlow (it starts with sfwp1_) and paste it again.', 'socialflow-auto-share' ) );
		} else {
			$result = self::request( 'connect', array( 'site' => self::site_info() ), 20, $creds );
			if ( ! is_wp_error( $result ) && 200 === $result['code'] && isset( $result['data']['connection'] ) && is_array( $result['data']['connection'] ) ) {
				$creds['connected_at'] = time();
				$creds['checked_at']   = time();
				$creds['info']         = $result['data']['connection'];
				self::save_connection( $creds );
				delete_transient( 'sfas_status' );
				self::notify( 'success', __( 'Connected to SocialFlow. New posts are shared from now on.', 'socialflow-auto-share' ) );
			} else {
				$host = wp_parse_url( $creds['api'], PHP_URL_HOST );
				/* translators: %s: SocialFlow's host name. */
				self::notify( 'error', self::message_of( $result, sprintf( __( 'SocialFlow at %s did not accept the key.', 'socialflow-auto-share' ), $host ) ) );
			}
		}
		wp_safe_redirect( self::settings_url() );
		exit;
	}

	public static function handle_disconnect() {
		self::guard( 'sfas_disconnect' );
		if ( self::connection() ) {
			// Best effort: the site is disconnected here whether or not SocialFlow hears about it.
			self::request( 'disconnect', array( 'site' => self::site_info() ), 8 );
		}
		delete_option( self::OPT_CONN );
		delete_transient( 'sfas_status' );
		wp_unschedule_hook( self::CRON_HOOK );
		self::notify( 'success', __( 'Disconnected. Posts are no longer sent to SocialFlow.', 'socialflow-auto-share' ) );
		wp_safe_redirect( self::settings_url() );
		exit;
	}

	public static function handle_save() {
		self::guard( 'sfas_save' );
		$available = array_keys( self::available_post_types() );
		$chosen    = isset( $_POST['sfas_post_types'] ) && is_array( $_POST['sfas_post_types'] ) ? array_map( 'sanitize_key', wp_unslash( $_POST['sfas_post_types'] ) ) : array();
		update_option(
			self::OPT_SETTINGS,
			array(
				'enabled'    => empty( $_POST['sfas_enabled'] ) ? 0 : 1,
				'post_types' => array_values( array_intersect( $available, $chosen ) ),
			)
		);
		self::notify( 'success', __( 'Settings saved.', 'socialflow-auto-share' ) );
		wp_safe_redirect( self::settings_url() );
		exit;
	}

	/** "Share now" on one post: sends it at once, whatever the automatic rules said. */
	public static function handle_share() {
		$post_id = isset( $_GET['post'] ) ? absint( $_GET['post'] ) : 0;
		self::guard( 'sfas_share_' . $post_id, 'edit_post', $post_id );
		if ( ! self::connection() ) {
			self::notify( 'error', __( 'Connect this site to SocialFlow first (Settings > SocialFlow).', 'socialflow-auto-share' ) );
		} else {
			list( $state, $message ) = self::send( $post_id, 1, true );
			self::notify( 'sent' === $state ? 'success' : ( 'skipped' === $state ? 'warning' : 'error' ), $message );
		}
		$back = wp_get_referer();
		wp_safe_redirect( $back ? $back : admin_url( 'edit.php' ) );
		exit;
	}

	/* ---------------------------------------------------------------------
	 * Admin: screens
	 * ------------------------------------------------------------------- */

	public static function admin_menu() {
		add_options_page( __( 'SocialFlow Auto-Share', 'socialflow-auto-share' ), __( 'SocialFlow', 'socialflow-auto-share' ), 'manage_options', self::SLUG, array( __CLASS__, 'render_settings' ) );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::settings_url() ) . '">' . esc_html__( 'Settings', 'socialflow-auto-share' ) . '</a>' );
		return $links;
	}

	public static function admin_notices() {
		$notice = get_transient( 'sfas_notice_' . get_current_user_id() );
		if ( is_array( $notice ) && ! empty( $notice['message'] ) ) {
			delete_transient( 'sfas_notice_' . get_current_user_id() );
			$type = in_array( $notice['type'], array( 'success', 'error', 'warning', 'info' ), true ) ? $notice['type'] : 'info';
			echo '<div class="notice notice-' . esc_attr( $type ) . ' is-dismissible"><p><strong>SocialFlow:</strong> ' . esc_html( $notice['message'] ) . '</p></div>';
		}
		$conn = self::connection();
		if ( $conn && ! empty( $conn['problem'] ) && current_user_can( 'manage_options' ) ) {
			$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
			if ( $screen && in_array( $screen->base, array( 'edit', 'plugins', 'dashboard', 'settings_page_' . self::SLUG ), true ) ) {
				echo '<div class="notice notice-error"><p><strong>' . esc_html__( 'SocialFlow Auto-Share is not sharing posts.', 'socialflow-auto-share' ) . '</strong> '
					. esc_html( $conn['problem'] ) . ' <a href="' . esc_url( self::settings_url() ) . '">' . esc_html__( 'Open the settings', 'socialflow-auto-share' ) . '</a></p></div>';
			}
		}
	}

	/** What SocialFlow says about this connection right now, cached for a minute. */
	private static function live_status( $refresh ) {
		$cached = $refresh ? false : get_transient( 'sfas_status' );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$result = self::request( 'status', array( 'site' => self::site_info() ), 12 );
		$conn   = self::connection();
		if ( ! is_wp_error( $result ) && 200 === $result['code'] && isset( $result['data']['connection'] ) && is_array( $result['data']['connection'] ) ) {
			$status = array(
				'ok'         => true,
				'connection' => $result['data']['connection'],
				'recent'     => isset( $result['data']['recent'] ) && is_array( $result['data']['recent'] ) ? $result['data']['recent'] : array(),
				'error'      => '',
			);
			if ( $conn ) {
				$conn['info']       = $status['connection'];
				$conn['checked_at'] = time();
				unset( $conn['problem'] );
				self::save_connection( $conn );
			}
		} else {
			$message = self::message_of( $result, __( 'SocialFlow did not answer.', 'socialflow-auto-share' ) );
			if ( self::is_cut_off( $result ) ) {
				self::flag_problem( $message );
			}
			$status = array(
				'ok'         => false,
				'connection' => $conn && isset( $conn['info'] ) && is_array( $conn['info'] ) ? $conn['info'] : array(),
				'recent'     => array(),
				'error'      => $message,
				'cut_off'    => self::is_cut_off( $result ),
			);
		}
		set_transient( 'sfas_status', $status, MINUTE_IN_SECONDS );
		return $status;
	}

	private static function mode_words( $mode ) {
		switch ( $mode ) {
			case 'publish':
				return __( 'Published straight away', 'socialflow-auto-share' );
			case 'queue':
				return __( 'Added to the queue', 'socialflow-auto-share' );
			case 'draft':
				return __( 'Saved as a draft in SocialFlow', 'socialflow-auto-share' );
		}
		return (string) $mode;
	}

	private static function state_words( $state ) {
		switch ( $state ) {
			case 'sent':
				return __( 'Shared', 'socialflow-auto-share' );
			case 'queued':
				return __( 'Waiting', 'socialflow-auto-share' );
			case 'failed':
				return __( 'Failed', 'socialflow-auto-share' );
			case 'skipped':
				return __( 'Not shared', 'socialflow-auto-share' );
		}
		return (string) $state;
	}

	/** Words for where a post stands in SocialFlow. */
	private static function share_words( array $share ) {
		$status = isset( $share['status'] ) ? $share['status'] : '';
		if ( 'failed' === $status ) {
			return __( 'Could not be posted', 'socialflow-auto-share' );
		}
		if ( 'pending' === $status ) {
			return __( 'Being handled', 'socialflow-auto-share' );
		}
		$post_status = isset( $share['postStatus'] ) ? $share['postStatus'] : null;
		switch ( $post_status ) {
			case 'published':
				return __( 'Published', 'socialflow-auto-share' );
			case 'publishing':
				return __( 'Publishing now', 'socialflow-auto-share' );
			case 'draft':
				return __( 'Draft in SocialFlow', 'socialflow-auto-share' );
			case 'failed':
				return __( 'Failed on a network (see SocialFlow)', 'socialflow-auto-share' );
			case 'scheduled':
				$when = ! empty( $share['postScheduledAt'] ) ? strtotime( $share['postScheduledAt'] ) : 0;
				if ( $when && $when > time() + MINUTE_IN_SECONDS ) {
					/* translators: %s: date and time. */
					return sprintf( __( 'Scheduled for %s', 'socialflow-auto-share' ), wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $when ) );
				}
				return __( 'Waiting to be published', 'socialflow-auto-share' );
			case null:
				return __( 'Removed in SocialFlow', 'socialflow-auto-share' );
		}
		return (string) $post_status;
	}

	private static function ago( $timestamp ) {
		/* translators: %s: a duration such as "5 mins". */
		return $timestamp ? sprintf( __( '%s ago', 'socialflow-auto-share' ), human_time_diff( (int) $timestamp, time() ) ) : '';
	}

	public static function render_settings() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$conn     = self::connection();
		$settings = self::settings();
		$refresh  = isset( $_GET['sfas_refresh'] ) && isset( $_GET['_wpnonce'] ) && wp_verify_nonce( sanitize_key( $_GET['_wpnonce'] ), 'sfas_refresh' );
		$status   = $conn ? self::live_status( $refresh ) : null;
		// A refresh can turn up that the key was withdrawn; read the connection again so that shows straight away.
		$conn       = self::connection();
		$info       = $status ? $status['connection'] : array();
		$action_url = admin_url( 'admin-post.php' );
		?>
		<div class="wrap sfas">
			<style>
				.sfas-card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;box-shadow:0 1px 1px rgba(0,0,0,.04);margin:16px 0;max-width:860px;padding:4px 20px 16px}
				.sfas-card h2{font-size:1.15em;margin:16px 0 8px}
				.sfas-state{align-items:center;display:flex;flex-wrap:wrap;font-size:14px;gap:8px;margin:8px 0}
				.sfas-dot{border-radius:50%;display:inline-block;flex:none;height:10px;width:10px}
				.sfas-dot--ok{background:#00a32a}.sfas-dot--off{background:#a7aaad}.sfas-dot--bad{background:#d63638}.sfas-dot--warn{background:#dba617}
				.sfas-facts{border-collapse:collapse;margin:4px 0 12px}
				.sfas-facts th{color:#50575e;font-weight:400;padding:5px 24px 5px 0;text-align:left;vertical-align:top;white-space:nowrap}
				.sfas-facts td{padding:5px 0;vertical-align:top}
				.sfas-chip{background:#f0f0f1;border-radius:999px;display:inline-block;margin:0 6px 4px 0;padding:2px 10px}
				.sfas-chip small{color:#50575e}
				.sfas-steps{margin:6px 0 14px 20px}.sfas-steps li{margin:0 0 6px}
				.sfas-muted{color:#646970}
				.sfas-pill{border-radius:3px;display:inline-block;font-size:12px;font-weight:600;line-height:1.6;padding:0 8px}
				.sfas-pill--sent{background:#edfaef;color:#00641a}.sfas-pill--queued{background:#fcf9e8;color:#7a5c00}
				.sfas-pill--failed{background:#fcf0f1;color:#8a2424}.sfas-pill--skipped{background:#f0f0f1;color:#50575e}
				.sfas-card .widefat td,.sfas-card .widefat th{vertical-align:top}
				.sfas-card details summary{cursor:pointer;margin:12px 0 8px}
			</style>
			<h1><?php esc_html_e( 'SocialFlow Auto-Share', 'socialflow-auto-share' ); ?></h1>

			<div class="sfas-card" id="sfas-connection">
				<h2><?php esc_html_e( 'Connection', 'socialflow-auto-share' ); ?></h2>
				<?php if ( ! $conn ) : ?>
					<p class="sfas-state"><span class="sfas-dot sfas-dot--off"></span> <strong><?php esc_html_e( 'Not connected', 'socialflow-auto-share' ); ?></strong></p>
					<ol class="sfas-steps">
						<li><?php esc_html_e( 'In SocialFlow, open Automations, choose New automation, then WordPress plugin, and pick the accounts to post to.', 'socialflow-auto-share' ); ?></li>
						<li><?php esc_html_e( 'Copy the connection key SocialFlow shows you.', 'socialflow-auto-share' ); ?></li>
						<li><?php esc_html_e( 'Paste it below and press Connect.', 'socialflow-auto-share' ); ?></li>
					</ol>
					<form method="post" action="<?php echo esc_url( $action_url ); ?>">
						<input type="hidden" name="action" value="sfas_connect">
						<?php wp_nonce_field( 'sfas_connect' ); ?>
						<p>
							<label for="sfas_key"><strong><?php esc_html_e( 'Connection key', 'socialflow-auto-share' ); ?></strong></label><br>
							<textarea id="sfas_key" name="sfas_key" rows="3" class="large-text code" spellcheck="false" autocomplete="off" required placeholder="sfwp1_..."></textarea>
						</p>
						<?php submit_button( __( 'Connect', 'socialflow-auto-share' ), 'primary', 'sfas_connect', false ); ?>
					</form>
				<?php else : ?>
					<?php
					$cut_off = ! empty( $conn['problem'] );
					$paused  = isset( $info['automationStatus'] ) && 'active' !== $info['automationStatus'];
					$host    = wp_parse_url( $conn['api'], PHP_URL_HOST );
					?>
					<p class="sfas-state">
						<?php if ( $cut_off ) : ?>
							<span class="sfas-dot sfas-dot--bad"></span> <strong><?php esc_html_e( 'Connection lost', 'socialflow-auto-share' ); ?></strong>
						<?php elseif ( $status && ! $status['ok'] ) : ?>
							<span class="sfas-dot sfas-dot--warn"></span> <strong><?php esc_html_e( 'Connected, but SocialFlow did not answer just now', 'socialflow-auto-share' ); ?></strong>
						<?php elseif ( $paused ) : ?>
							<span class="sfas-dot sfas-dot--warn"></span> <strong><?php esc_html_e( 'Connected, sharing is paused in SocialFlow', 'socialflow-auto-share' ); ?></strong>
						<?php else : ?>
							<span class="sfas-dot sfas-dot--ok"></span> <strong><?php esc_html_e( 'Connected', 'socialflow-auto-share' ); ?></strong>
						<?php endif; ?>
						<span class="sfas-muted"><?php echo esc_html( $host ); ?></span>
					</p>
					<?php if ( $cut_off ) : ?>
						<p><?php echo esc_html( $conn['problem'] ); ?> <?php esc_html_e( 'Disconnect, then connect again with a new key from SocialFlow.', 'socialflow-auto-share' ); ?></p>
					<?php elseif ( $status && ! $status['ok'] ) : ?>
						<p class="sfas-muted"><?php echo esc_html( $status['error'] ); ?> <?php esc_html_e( 'Posts published meanwhile are sent again automatically.', 'socialflow-auto-share' ); ?></p>
					<?php endif; ?>
					<?php if ( ! empty( $info ) ) : ?>
						<table class="sfas-facts">
							<tr><th><?php esc_html_e( 'Workspace', 'socialflow-auto-share' ); ?></th><td><?php echo esc_html( isset( $info['workspaceName'] ) ? $info['workspaceName'] : '' ); ?></td></tr>
							<tr><th><?php esc_html_e( 'Automation', 'socialflow-auto-share' ); ?></th><td><?php echo esc_html( isset( $info['automationName'] ) ? $info['automationName'] : '' ); ?></td></tr>
							<tr>
								<th><?php esc_html_e( 'Posts go to', 'socialflow-auto-share' ); ?></th>
								<td>
									<?php
									$accounts = isset( $info['accounts'] ) && is_array( $info['accounts'] ) ? $info['accounts'] : array();
									if ( empty( $accounts ) ) {
										esc_html_e( 'No accounts. Choose some for this automation in SocialFlow.', 'socialflow-auto-share' );
									}
									foreach ( $accounts as $account ) {
										$needs = isset( $account['status'] ) && 'active' !== $account['status'];
										echo '<span class="sfas-chip">' . esc_html( isset( $account['name'] ) ? $account['name'] : '' )
											. ' <small>' . esc_html( ucfirst( isset( $account['platform'] ) ? $account['platform'] : '' ) )
											. ( $needs ? ' &middot; ' . esc_html__( 'needs reconnecting in SocialFlow', 'socialflow-auto-share' ) : '' ) . '</small></span>';
									}
									?>
								</td>
							</tr>
							<tr><th><?php esc_html_e( 'Each post is', 'socialflow-auto-share' ); ?></th><td><?php echo esc_html( self::mode_words( isset( $info['mode'] ) ? $info['mode'] : '' ) ); ?></td></tr>
							<tr><th><?php esc_html_e( 'Posts shared', 'socialflow-auto-share' ); ?></th><td><?php echo esc_html( number_format_i18n( isset( $info['postsCreated'] ) ? (int) $info['postsCreated'] : 0 ) ); ?></td></tr>
							<tr>
								<th><?php esc_html_e( 'Last checked', 'socialflow-auto-share' ); ?></th>
								<td>
									<?php echo esc_html( self::ago( isset( $conn['checked_at'] ) ? $conn['checked_at'] : 0 ) ); ?>
									&nbsp;<a href="<?php echo esc_url( wp_nonce_url( add_query_arg( 'sfas_refresh', '1', self::settings_url() ), 'sfas_refresh' ) ); ?>"><?php esc_html_e( 'Check now', 'socialflow-auto-share' ); ?></a>
								</td>
							</tr>
						</table>
					<?php endif; ?>
					<p class="sfas-muted"><?php esc_html_e( 'The accounts, the text of the social post and whether it is published straight away are chosen in SocialFlow.', 'socialflow-auto-share' ); ?>
						<?php if ( ! empty( $info['dashboardUrl'] ) ) : ?>
							<a href="<?php echo esc_url( $info['dashboardUrl'] ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Open SocialFlow', 'socialflow-auto-share' ); ?></a>
						<?php endif; ?>
					</p>
					<form method="post" action="<?php echo esc_url( $action_url ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect this site from SocialFlow? Posts will no longer be shared.', 'socialflow-auto-share' ) ); ?>');">
						<input type="hidden" name="action" value="sfas_disconnect">
						<?php wp_nonce_field( 'sfas_disconnect' ); ?>
						<?php submit_button( __( 'Disconnect', 'socialflow-auto-share' ), 'secondary', 'sfas_disconnect', false ); ?>
					</form>
				<?php endif; ?>
			</div>

			<div class="sfas-card" id="sfas-sharing">
				<h2><?php esc_html_e( 'Sharing', 'socialflow-auto-share' ); ?></h2>
				<form method="post" action="<?php echo esc_url( $action_url ); ?>">
					<input type="hidden" name="action" value="sfas_save">
					<?php wp_nonce_field( 'sfas_save' ); ?>
					<p>
						<label><input type="checkbox" name="sfas_enabled" value="1" <?php checked( $settings['enabled'], 1 ); ?>>
							<strong><?php esc_html_e( 'Share posts automatically when they are published', 'socialflow-auto-share' ); ?></strong></label><br>
						<span class="sfas-muted"><?php esc_html_e( 'A post is shared once. Editing it later, or publishing it again, does not share it a second time.', 'socialflow-auto-share' ); ?></span>
					</p>
					<fieldset>
						<legend><strong><?php esc_html_e( 'What to share', 'socialflow-auto-share' ); ?></strong></legend>
						<?php foreach ( self::available_post_types() as $type ) : ?>
							<label style="display:inline-block;margin:6px 16px 0 0"><input type="checkbox" name="sfas_post_types[]" value="<?php echo esc_attr( $type->name ); ?>" <?php checked( in_array( $type->name, $settings['post_types'], true ) ); ?>>
								<?php echo esc_html( $type->labels->name ); ?></label>
						<?php endforeach; ?>
					</fieldset>
					<p><?php submit_button( __( 'Save changes', 'socialflow-auto-share' ), 'primary', 'sfas_save', false ); ?></p>
				</form>
			</div>

			<div class="sfas-card" id="sfas-activity">
				<h2><?php esc_html_e( 'Recent shares', 'socialflow-auto-share' ); ?></h2>
				<?php $recent = $status && $status['ok'] ? $status['recent'] : array(); ?>
				<?php if ( ! $conn ) : ?>
					<p class="sfas-muted"><?php esc_html_e( 'Shared posts are listed here once the site is connected.', 'socialflow-auto-share' ); ?></p>
				<?php elseif ( empty( $recent ) ) : ?>
					<p class="sfas-muted"><?php echo esc_html( $status && ! $status['ok'] ? __( 'The list comes from SocialFlow, which did not answer just now.', 'socialflow-auto-share' ) : __( 'Nothing has been shared yet. Publish a post and it appears here.', 'socialflow-auto-share' ) ); ?></p>
				<?php else : ?>
					<table class="widefat striped">
						<thead><tr><th><?php esc_html_e( 'Post', 'socialflow-auto-share' ); ?></th><th><?php esc_html_e( 'In SocialFlow', 'socialflow-auto-share' ); ?></th><th><?php esc_html_e( 'Sent', 'socialflow-auto-share' ); ?></th></tr></thead>
						<tbody>
							<?php foreach ( $recent as $share ) : ?>
								<?php if ( ! is_array( $share ) ) { continue; } ?>
								<tr>
									<td>
										<?php $title = ! empty( $share['title'] ) ? $share['title'] : ( ! empty( $share['url'] ) ? $share['url'] : __( '(no title)', 'socialflow-auto-share' ) ); ?>
										<?php if ( ! empty( $share['url'] ) ) : ?>
											<a href="<?php echo esc_url( $share['url'] ); ?>"><?php echo esc_html( $title ); ?></a>
										<?php else : ?>
											<?php echo esc_html( $title ); ?>
										<?php endif; ?>
									</td>
									<td>
										<?php echo esc_html( self::share_words( $share ) ); ?>
										<?php if ( ! empty( $share['error'] ) ) : ?>
											<br><span class="sfas-muted"><?php echo esc_html( $share['error'] ); ?></span>
										<?php endif; ?>
									</td>
									<td><?php echo esc_html( self::ago( ! empty( $share['createdAt'] ) ? strtotime( $share['createdAt'] ) : 0 ) ); ?></td>
								</tr>
							<?php endforeach; ?>
						</tbody>
					</table>
				<?php endif; ?>

				<?php $log = get_option( self::OPT_LOG ); ?>
				<?php if ( is_array( $log ) && ! empty( $log ) ) : ?>
					<details>
						<summary><?php esc_html_e( 'What this site did (latest 20)', 'socialflow-auto-share' ); ?></summary>
						<table class="widefat striped">
							<thead><tr><th><?php esc_html_e( 'When', 'socialflow-auto-share' ); ?></th><th><?php esc_html_e( 'Post', 'socialflow-auto-share' ); ?></th><th><?php esc_html_e( 'Result', 'socialflow-auto-share' ); ?></th></tr></thead>
							<tbody>
								<?php foreach ( $log as $entry ) : ?>
									<?php if ( ! is_array( $entry ) ) { continue; } ?>
									<tr>
										<td><?php echo esc_html( self::ago( isset( $entry['time'] ) ? $entry['time'] : 0 ) ); ?></td>
										<td><?php echo esc_html( isset( $entry['title'] ) && '' !== $entry['title'] ? $entry['title'] : '#' . ( isset( $entry['post'] ) ? (int) $entry['post'] : 0 ) ); ?></td>
										<td>
											<span class="sfas-pill sfas-pill--<?php echo esc_attr( isset( $entry['state'] ) ? $entry['state'] : '' ); ?>"><?php echo esc_html( self::state_words( isset( $entry['state'] ) ? $entry['state'] : '' ) ); ?></span>
											<?php echo esc_html( isset( $entry['message'] ) ? $entry['message'] : '' ); ?>
										</td>
									</tr>
								<?php endforeach; ?>
							</tbody>
						</table>
					</details>
				<?php endif; ?>
			</div>
		</div>
		<?php
	}

	/* ---------------------------------------------------------------------
	 * Admin: the posts list
	 * ------------------------------------------------------------------- */

	public static function admin_columns() {
		$settings = self::settings();
		foreach ( $settings['post_types'] as $type ) {
			add_filter( 'manage_' . $type . '_posts_columns', array( __CLASS__, 'add_column' ) );
			add_action( 'manage_' . $type . '_posts_custom_column', array( __CLASS__, 'render_column' ), 10, 2 );
		}
		add_action( 'admin_head-edit.php', array( __CLASS__, 'column_style' ) );
	}

	public static function column_style() {
		echo '<style>.column-sfas{width:12%}.sfas-col{font-size:12px}.sfas-col--sent{color:#00641a}.sfas-col--failed{color:#b32d2e}.sfas-col--queued{color:#7a5c00}.sfas-col--skipped,.sfas-col--none{color:#646970}</style>';
	}

	public static function add_column( $columns ) {
		$columns['sfas'] = __( 'SocialFlow', 'socialflow-auto-share' );
		return $columns;
	}

	public static function render_column( $column, $post_id ) {
		if ( 'sfas' !== $column ) {
			return;
		}
		$status = get_post_meta( $post_id, self::META_STATUS, true );
		if ( ! is_array( $status ) || empty( $status['state'] ) ) {
			echo '<span class="sfas-col sfas-col--none" aria-hidden="true">&mdash;</span><span class="screen-reader-text">' . esc_html__( 'Not shared', 'socialflow-auto-share' ) . '</span>';
			return;
		}
		$message = isset( $status['message'] ) ? $status['message'] : '';
		echo '<span class="sfas-col sfas-col--' . esc_attr( $status['state'] ) . '" title="' . esc_attr( $message ) . '"><strong>' . esc_html( self::state_words( $status['state'] ) ) . '</strong>';
		if ( ! empty( $status['time'] ) ) {
			echo '<br>' . esc_html( self::ago( $status['time'] ) );
		}
		if ( 'sent' !== $status['state'] && '' !== $message ) {
			echo '<br>' . esc_html( $message );
		}
		echo '</span>';
	}

	public static function row_actions( $actions, $post ) {
		if ( ! ( $post instanceof WP_Post ) || 'publish' !== $post->post_status || ! self::connection() || ! current_user_can( 'edit_post', $post->ID ) ) {
			return $actions;
		}
		$settings = self::settings();
		if ( ! in_array( $post->post_type, $settings['post_types'], true ) ) {
			return $actions;
		}
		$status = get_post_meta( $post->ID, self::META_STATUS, true );
		if ( is_array( $status ) && isset( $status['state'] ) && 'sent' === $status['state'] ) {
			return $actions;
		}
		$url             = wp_nonce_url( admin_url( 'admin-post.php?action=sfas_share&post=' . $post->ID ), 'sfas_share_' . $post->ID );
		$actions['sfas'] = '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Share now', 'socialflow-auto-share' ) . '</a>';
		return $actions;
	}

	/* ---------------------------------------------------------------------
	 * Per post: "share on social media"
	 * ------------------------------------------------------------------- */

	/** Lets the block editor save the choice with the post, so it is known the moment the post is published. */
	public static function register_meta() {
		$settings = self::settings();
		foreach ( $settings['post_types'] as $type ) {
			register_post_meta(
				$type,
				self::META_SKIP,
				array(
					'type'          => 'boolean',
					'single'        => true,
					'default'       => false,
					'show_in_rest'  => true,
					'auth_callback' => array( __CLASS__, 'can_edit_meta' ),
				)
			);
		}
	}

	public static function can_edit_meta( $allowed, $meta_key, $post_id ) {
		return current_user_can( 'edit_post', $post_id );
	}

	public static function editor_assets() {
		$screen   = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		$settings = self::settings();
		if ( ! $screen || ! in_array( $screen->post_type, $settings['post_types'], true ) || ! self::connection() || ! $settings['enabled'] ) {
			return;
		}
		wp_enqueue_script( 'sfas-editor', plugins_url( 'assets/editor.js', __FILE__ ), array( 'wp-plugins', 'wp-element', 'wp-data', 'wp-components', 'wp-editor', 'wp-edit-post' ), self::VERSION, true );
		wp_localize_script(
			'sfas-editor',
			'sfasEditor',
			array(
				'label' => __( 'Share on social media', 'socialflow-auto-share' ),
				'help'  => __( 'Sent to SocialFlow when this is published.', 'socialflow-auto-share' ),
			)
		);
	}

	/** The same choice for the classic editor. The block editor uses the panel in assets/editor.js instead. */
	public static function add_meta_box() {
		if ( ! self::connection() ) {
			return;
		}
		$settings = self::settings();
		foreach ( $settings['post_types'] as $type ) {
			add_meta_box( 'sfas-share', __( 'SocialFlow', 'socialflow-auto-share' ), array( __CLASS__, 'render_meta_box' ), $type, 'side', 'default', array( '__back_compat_meta_box' => true ) );
		}
	}

	public static function render_meta_box( $post ) {
		$status = get_post_meta( $post->ID, self::META_STATUS, true );
		wp_nonce_field( 'sfas_meta_' . $post->ID, 'sfas_meta_nonce' );
		if ( is_array( $status ) && ! empty( $status['state'] ) ) {
			echo '<p><strong>' . esc_html( self::state_words( $status['state'] ) ) . '</strong>' . ( ! empty( $status['time'] ) ? ' &middot; ' . esc_html( self::ago( $status['time'] ) ) : '' ) . '<br>' . esc_html( isset( $status['message'] ) ? $status['message'] : '' ) . '</p>';
		}
		if ( 'publish' !== $post->post_status ) {
			echo '<label><input type="checkbox" name="sfas_share" value="1" ' . checked( ! get_post_meta( $post->ID, self::META_SKIP, true ), true, false ) . '> ' . esc_html__( 'Share on social media when published', 'socialflow-auto-share' ) . '</label>';
			echo '<input type="hidden" name="sfas_share_present" value="1">';
		}
	}

	public static function save_meta_box( $post_id ) {
		if ( ! isset( $_POST['sfas_share_present'], $_POST['sfas_meta_nonce'] ) || ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) ) {
			return;
		}
		if ( ! wp_verify_nonce( sanitize_key( $_POST['sfas_meta_nonce'] ), 'sfas_meta_' . $post_id ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}
		if ( empty( $_POST['sfas_share'] ) ) {
			update_post_meta( $post_id, self::META_SKIP, 1 );
		} else {
			delete_post_meta( $post_id, self::META_SKIP );
		}
	}
}

register_activation_hook( __FILE__, array( 'SocialFlow_Auto_Share', 'on_activate' ) );
register_deactivation_hook( __FILE__, array( 'SocialFlow_Auto_Share', 'on_deactivate' ) );
add_action( 'plugins_loaded', array( 'SocialFlow_Auto_Share', 'init' ) );
