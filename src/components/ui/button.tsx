import * as React from 'react';
import { cn } from '../../lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'outline' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  default:
    'bg-zinc-100 text-zinc-900 hover:bg-zinc-200',
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm',
  outline:
    'border border-zinc-700 bg-transparent text-zinc-100 hover:bg-zinc-800/60',
  secondary:
    'bg-zinc-800 text-zinc-50 hover:bg-zinc-700',
  ghost:
    'text-zinc-400 hover:bg-zinc-800/70 hover:text-white',
  destructive:
    'bg-red-600 text-white hover:bg-red-500 shadow-sm',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-8 px-3 text-[11px] gap-1.5',
  md: 'h-9 px-4 text-xs gap-1.5',
  lg: 'h-10 px-5 text-sm gap-2',
  icon: 'h-9 w-9 p-0',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-lg font-medium tracking-tight',
          'transition-all duration-150 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
          'disabled:opacity-50 disabled:pointer-events-none',
          'active:scale-[0.97]',
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
