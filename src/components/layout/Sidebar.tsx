import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Avatar } from '../ui/avatar';
import { Tooltip } from '../ui/tooltip';
import {
  LayoutDashboard,
  Target,
  MessageCircle,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Zap,
} from 'lucide-react';

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  roles: string[];
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Builder',
    path: '/',
    icon: <LayoutDashboard className="w-5 h-5" />,
    roles: ['superadmin', 'associate', 'builder'],
  },
  {
    label: 'Sales Funnel',
    path: '/sales-funnel',
    icon: <Target className="w-5 h-5" />,
    roles: ['superadmin', 'associate', 'salesperson'],
  },
  {
    label: 'Messaging',
    path: '/twilio-messaging',
    icon: <MessageCircle className="w-5 h-5" />,
    roles: ['superadmin', 'associate', 'whatsapp_manager'],
  },
];

export const Sidebar: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const visibleItems = NAV_ITEMS.filter(
    (item) => !user || item.roles.includes(user.role)
  );

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <aside className={`app-sidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Toggle Button */}
      <button
        className="sidebar-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
      </button>

      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">
          <Zap className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <div className="flex flex-col">
            <span className="text-sm font-bold text-zinc-100 font-heading tracking-tight">LearnXR</span>
            <span className="text-[10px] text-zinc-500 font-medium">Platform</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        {!collapsed && (
          <div className="sidebar-section-label">Navigation</div>
        )}
        {visibleItems.map((item) => {
          const active = isActive(item.path);
          const linkContent = (
            <Link
              key={item.path}
              to={item.path}
              className={`sidebar-item ${active ? 'active' : ''}`}
            >
              <span className="sidebar-item-icon">{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.path} content={item.label} side="right">
                {linkContent}
              </Tooltip>
            );
          }
          return linkContent;
        })}
      </nav>

      {/* User Section */}
      <div className="sidebar-user">
        <Avatar name={user?.name} size="sm" />
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-zinc-200 truncate">{user?.name}</p>
            <p className="text-[10px] text-zinc-500 capitalize">{user?.role?.replace('_', ' ')}</p>
          </div>
        )}
        {collapsed ? (
          <Tooltip content="Sign out" side="right">
            <button onClick={logout} className="sidebar-item p-2 w-auto">
              <LogOut className="w-4 h-4 text-zinc-500" />
            </button>
          </Tooltip>
        ) : (
          <button
            onClick={logout}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-all"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </div>
    </aside>
  );
};
