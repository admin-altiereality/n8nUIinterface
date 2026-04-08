import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { UserRole } from '../types/auth';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: UserRole[];
}

/**
 * Returns the default landing page for a given role.
 */
function getDefaultPageForRole(role: UserRole): string {
  switch (role) {
    case 'salesperson': return '/sales-funnel';
    case 'whatsapp_manager': return '/twilio-messaging';
    case 'builder': return '/';
    case 'superadmin': return '/';
    case 'associate': return '/';
    default: return '/';
  }
}

const PermissionDenied: React.FC = () => {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg-app)' }}>
      <div className="surface-card max-w-md w-full p-8 rounded-xl text-center space-y-6 animate-fade-in">
        <div className="mx-auto h-16 w-16 rounded-xl bg-red-500/10 flex items-center justify-center border border-red-500/20">
          <ShieldAlert className="w-8 h-8 text-red-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-zinc-100 font-heading">Access Denied</h2>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Your current role does not have permission to view this page. Please contact your administrator if you believe this is an error.
          </p>
        </div>
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-xs font-semibold text-red-400 hover:text-red-300 transition-all"
        >
          <ArrowLeft className="w-4 h-4" /> Return to Dashboard
        </Link>
      </div>
    </div>
  );
};

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedRoles }) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-app)' }}>
        <div className="h-10 w-10 border-3 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    // Instead of showing Access Denied, redirect to the user's default page
    const defaultPage = getDefaultPageForRole(user.role);
    if (defaultPage !== location.pathname) {
      return <Navigate to={defaultPage} replace />;
    }
    // If already on their default page and still denied, show the error
    return <PermissionDenied />;
  }

  return <>{children}</>;
};
