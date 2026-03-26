import { cva } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-slate-100 text-slate-900',
        secondary: 'border-border bg-slate-800/50 text-slate-200',
        success: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300',
        danger: 'border-rose-500/70 bg-rose-500/10 text-rose-200',
        warning: 'border-amber-500/60 bg-amber-500/10 text-amber-200',
        outline: 'border-white/10 bg-transparent text-slate-300'
      }
    },
    defaultVariants: {
      variant: 'secondary'
    }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'success' | 'danger' | 'warning' | 'outline';
}

export const Badge = ({ className, variant, ...props }: BadgeProps) => {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
};

