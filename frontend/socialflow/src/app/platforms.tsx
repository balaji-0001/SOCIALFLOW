import type { ComponentType } from 'react';
import { Facebook, Instagram, Linkedin, Youtube } from 'lucide-react';
import type { ConnectedAccount, Platform, Post } from '@workspace/api-client-react';

type PlatformIcon = ComponentType<{ size?: number | string; strokeWidth?: number | string; color?: string }>;

/** X's mark. The icon set has no X logo (its "X" is a close button), so it is drawn here; it is a filled shape, so strokeWidth doesn't apply. */
function XLogo({ size = 24, color = 'currentColor' }: { size?: number | string; strokeWidth?: number | string; color?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>;
}

/** charLimit is counted the way the network counts: for X that is its weighted length (see twitter-text.ts). */
export const PLATFORM_META: Record<Platform, { name: string; color: string; charLimit: number; needsMedia: boolean; Icon: PlatformIcon }> = {
  facebook: { name: 'Facebook', color: '#1877f2', charLimit: 63206, needsMedia: false, Icon: Facebook },
  instagram: { name: 'Instagram', color: '#d6249f', charLimit: 2200, needsMedia: true, Icon: Instagram },
  linkedin: { name: 'LinkedIn', color: '#0a66c2', charLimit: 3000, needsMedia: false, Icon: Linkedin },
  youtube: { name: 'YouTube', color: '#e02d2d', charLimit: 5000, needsMedia: true, Icon: Youtube },
  twitter: { name: 'X', color: '#000000', charLimit: 280, needsMedia: false, Icon: XLogo },
};

export function PlatformBadge({ platform, size = 16 }: { platform: Platform; size?: number }) {
  const { Icon, color, name } = PLATFORM_META[platform];
  return <span className="sfa-pbadge" data-platform={platform} style={{ background: color, height: size + 6, width: size + 6 }} title={name}><Icon size={size - 4} strokeWidth={2.4} color="#fff" /></span>;
}

export function AccountAvatar({ account, size = 36 }: { account: Pick<ConnectedAccount, 'displayName' | 'avatarUrl' | 'platform'>; size?: number }) {
  return <span className="sfa-avatar" style={{ height: size, width: size }}>
    {account.avatarUrl
      ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" />
      : <span>{account.displayName.slice(0, 1).toUpperCase()}</span>}
    <PlatformBadge platform={account.platform} size={12} />
  </span>;
}

export const STATUS_LABEL: Record<Post['status'], string> = { draft: 'Draft', scheduled: 'Scheduled', publishing: 'Publishing…', published: 'Published', failed: 'Failed' };

export function StatusPill({ status }: { status: Post['status'] }) {
  return <span className={`sfa-pill sfa-pill--${status}`}>{STATUS_LABEL[status]}</span>;
}

/** The first line of a post, for calendar chips and list rows. */
export function snippet(content: string, max = 90): string {
  const text = content.trim().replace(/\s+/g, ' ');
  if (text.length === 0) return 'Untitled draft';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function uniquePlatforms(post: Post): Platform[] {
  return [...new Set(post.targets.map((target) => target.platform))];
}
