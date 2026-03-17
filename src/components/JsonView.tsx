import React from 'react';

interface JsonViewProps {
  data: any;
  title?: string;
}

export const JsonView: React.FC<JsonViewProps> = ({ data, title }) => {
  if (data === undefined) return null;

  return (
    <div className="space-y-1.5">
      {title && (
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h4>
      )}
      <div className="rounded-lg border border-slate-800 bg-slate-950 p-2.5 shadow-inner">
        <pre className="max-h-[300px] overflow-auto text-[10px] leading-relaxed text-sky-300/90 selection:bg-sky-500/30">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
};
