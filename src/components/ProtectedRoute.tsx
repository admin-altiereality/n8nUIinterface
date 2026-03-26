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

const PermissionDenied: React.FC = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-6">
      <div className="glass-card max-w-md w-full p-8 rounded-3xl text-center space-y-6 animate-scale-in">
        <div className="mx-auto h-20 w-20 rounded-[40px] bg-rose-500/10 flex items-center justify-center border border-rose-500/20">
          <ShieldAlert className="size-10 text-rose-500" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-slate-100 uppercase tracking-tight font-heading">Access Denied</h2>
          <p className="text-sm text-slate-400 leading-relaxed font-medium">
            Your current role does not have permission to view this restricted page. Please contact a superadmin if you believe this is an error.
          </p>
        </div>
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-rose-400 hover:text-rose-300 transition-all"
        >
          <ArrowLeft className="size-4" /> Return to Dashboard
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
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="h-12 w-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <PermissionDenied />;
  }

  return <>{children}</>;
};
