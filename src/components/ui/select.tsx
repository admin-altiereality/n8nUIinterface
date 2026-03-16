import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs',
          'text-slate-50 shadow-sm placeholder:text-slate-500',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
          'appearance-none bg-[length:10px_6px] bg-[right_0.85rem_center] bg-no-repeat',
          "bg-[url(\"data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M10.6667 1.33331L6.00004 5.99998L1.33337 1.33331' stroke='%23E5E7EB' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E%0A\")]",
          'disabled:cursor-not-allowed disabled:opacity-60',
          'ring-offset-slate-950',
          className
        )}
        {...props}
      >
        {children}
      </select>
    );
  }
);

Select.displayName = 'Select';

