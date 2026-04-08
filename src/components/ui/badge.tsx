import { cva } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-zinc-100 text-zinc-900',
        secondary: 'border-zinc-700 bg-zinc-800/50 text-zinc-300',
        success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
        danger: 'border-red-500/30 bg-red-500/10 text-red-400',
        warning: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
        info: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
        outline: 'border-zinc-700 bg-transparent text-zinc-400',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'outline';
}

export const Badge = ({ className, variant, ...props }: BadgeProps) => {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
};
