/*
 * SocialFlow Auto-Share: the "Share on social media" tick box in the block editor's post summary.
 * It edits the post's own meta (_sfas_skip), so the choice is saved in the same request that publishes the post
 * and the plugin knows it the moment the post goes live. No build step: plain JavaScript on WordPress's globals.
 */
( function ( wp ) {
	if ( ! wp || ! wp.plugins || ! wp.element || ! wp.data || ! wp.components ) {
		return;
	}
	var StatusInfo = ( wp.editor && wp.editor.PluginPostStatusInfo ) || ( wp.editPost && wp.editPost.PluginPostStatusInfo );
	if ( ! StatusInfo ) {
		return;
	}
	var el = wp.element.createElement;
	var words = window.sfasEditor || {};

	function ShareToggle() {
		var post = wp.data.useSelect( function ( select ) {
			var editor = select( 'core/editor' );
			return { meta: editor.getEditedPostAttribute( 'meta' ), status: editor.getCurrentPostAttribute( 'status' ) };
		}, [] );
		var editPost = wp.data.useDispatch( 'core/editor' ).editPost;

		// A post type without custom fields has no meta in the editor, and a published post has already been handled.
		if ( ! post.meta || typeof post.meta._sfas_skip === 'undefined' || post.status === 'publish' ) {
			return null;
		}
		return el(
			StatusInfo,
			{ className: 'sfas-share-toggle' },
			el( wp.components.CheckboxControl, {
				label: words.label || 'Share on social media',
				help: words.help || '',
				checked: ! post.meta._sfas_skip,
				onChange: function ( share ) {
					editPost( { meta: { _sfas_skip: ! share } } );
				},
				__nextHasNoMarginBottom: true
			} )
		);
	}

	wp.plugins.registerPlugin( 'socialflow-auto-share', { render: ShareToggle } );
} )( window.wp );
