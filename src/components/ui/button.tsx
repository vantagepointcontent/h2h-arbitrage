import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'compact' | 'standard';
const tones: Record<Tone, string> = {
  primary: 'border-transparent bg-[var(--status-positive)] text-[var(--surface-workspace)] hover:brightness-110',
  secondary: 'border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
  danger: 'border-[var(--status-negative)]/40 bg-[var(--status-negative)]/10 text-[var(--status-negative)] hover:bg-[var(--status-negative)]/20',
  ghost: 'border-transparent bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
};
const sizes: Record<Size, string> = { compact: 'min-h-8 px-2.5 text-xs', standard: 'min-h-11 px-3 text-[13px]' };
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { tone?: Tone; size?: Size; loading?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, tone='secondary', size='standard', loading=false, disabled, children, ...props }, ref) {
  return <button ref={ref} disabled={disabled || loading} className={cn('inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-workspace)] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50', tones[tone], sizes[size], className)} {...props}>{loading && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}{children}</button>;
});
