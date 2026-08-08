import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
export function Skeleton({className,...props}:HTMLAttributes<HTMLDivElement>){return <div className={cn('h-4 animate-pulse rounded-[var(--radius-control)] bg-[var(--surface-raised)] motion-reduce:animate-none',className)} {...props}/>}
