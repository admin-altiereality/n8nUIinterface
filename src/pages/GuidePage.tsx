import React, { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GUIDE_HTML } from './guide/guideContent';

// Screenshots with lead details blurred (src/assets/guide), keyed by file name.
const IMAGES = import.meta.glob('../assets/guide/*.jpg', { eager: true, import: 'default' }) as Record<string, string>;
const imageUrl = (name: string) => IMAGES[`../assets/guide/${name}.jpg`] ?? '';

export default function GuidePage() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const html = useMemo(() => GUIDE_HTML.replace(/\{\{img:([a-z-]+)\}\}/g, (_, name: string) => imageUrl(name)), []);

  // Opening /guide#section scrolls to that section once the content is in the page.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  // Links to dashboard pages (/sales, /pipeline…) stay inside the app; #section links scroll.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href');
    if (!href || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (href.startsWith('#')) {
      e.preventDefault();
      document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
      window.history.replaceState(null, '', href);
    } else if (href.startsWith('/')) {
      e.preventDefault();
      navigate(href);
    }
  };

  return <div className="guide animate-fade-in" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
