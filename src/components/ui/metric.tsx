import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
const tones={neutral:'text-[var(--text-primary)]',positive:'text-[var(--status-positive)]',negative:'text-[var(--status-negative)]',warning:'text-[var(--status-warning)]'};
export function Metric({label,value,hint,tone='neutral',className,...props}:HTMLAttributes<HTMLDivElement>&{label:string;value:ReactNode;hint?:ReactNode;tone?:keyof typeof tones}){return <div className={cn('min-w-0',className)} {...props}><div className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</div><div className={cn('mt-0.5 truncate text-sm font-semibold tabular-nums',tones[tone])}>{value}</div>{hint&&<div className="mt-0.5 text-[10px] text-[var(--text-faint)]">{hint}</div>}</div>}
