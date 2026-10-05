import { Moon, Sun } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from '@/lib/theme';

/** One-click light/dark switch, used in the site header, the app top bar and the sign-in pages. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolved, toggle } = useTheme();
  const dark = resolved === 'aurora';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className={`sfa-themetoggle ${className}`} onClick={toggle} aria-label={label} aria-pressed={dark} data-testid="button-theme-toggle">
        {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
      </button>
    </TooltipTrigger>
    <TooltipContent className="sfa-tip">{label}</TooltipContent>
  </Tooltip>;
}
