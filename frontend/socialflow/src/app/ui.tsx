import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';

/* Small, reusable presentation primitives for the signed-in app. Styles live in app.css. */

export function Spinner({ size = 16 }: { size?: number }) {
  return <svg className="sfa-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>;
}

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, children, className = '', disabled, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`sfa-btn sfa-btn--${variant} sfa-btn--${size} ${loading ? 'is-loading' : ''} ${className}`}
    disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
    {loading ? <Spinner size={size === 'sm' ? 13 : 15} /> : icon}
    {children}
  </button>;
}

export function IconButton({ label, children, className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type={type} className={`sfa-iconbtn ${className}`} aria-label={label} title={label} {...rest}>{children}</button>;
}

/** A placeholder that matches the layout of the content it stands in for. */
export function Skeleton({ width, height = 14, radius, className = '' }: { width?: number | string; height?: number | string; radius?: number | string; className?: string }) {
  return <span className={`sfa-skel ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: string }) {
  return <header className="sfa-pageheader">
    <div>
      {eyebrow && <span className="sfa-eyebrow">{eyebrow}</span>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="sfa-pageheader__actions">{actions}</div>}
  </header>;
}

export function EmptyState({ icon, title, description, action, secondary }: { icon: ReactNode; title: string; description: ReactNode; action?: ReactNode; secondary?: ReactNode }) {
  return <div className="sfa-emptystate">
    <span className="sfa-emptystate__icon" aria-hidden="true">{icon}</span>
    <h3>{title}</h3>
    <p>{description}</p>
    {(action || secondary) && <div className="sfa-emptystate__actions">{action}{secondary}</div>}
  </div>;
}

export function ErrorState({ title = "Couldn't load this", description = 'Check your connection and try again. Your data is safe.', onRetry }: { title?: string; description?: string; onRetry?: () => void }) {
  return <div className="sfa-errorstate" role="alert">
    <span className="sfa-emptystate__icon sfa-emptystate__icon--error" aria-hidden="true"><CircleAlert size={22} /></span>
    <h3>{title}</h3>
    <p>{description}</p>
    {onRetry && <Button variant="outline" icon={<RefreshCw size={14} />} onClick={onRetry}>Try again</Button>}
  </div>;
}
