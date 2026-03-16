import * as React from 'react';
import { cn } from '../../lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  default:
    'bg-slate-100 text-slate-950 hover:bg-slate-200 dark:bg-slate-100 dark:hover:bg-slate-200',
  outline:
    'border border-slate-600/80 bg-transparent text-slate-100 hover:bg-slate-800/60',
  secondary:
    'bg-slate-800 text-slate-50 hover:bg-slate-700',
  ghost:
    'text-slate-200 hover:bg-slate-800/70 hover:text-white'
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-8 px-3 text-[11px]',
  md: 'h-9 px-4 text-xs',
  lg: 'h-10 px-6 text-sm'
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-full font-medium tracking-tight',
          'transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
          'disabled:opacity-60 disabled:pointer-events-none',
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';

