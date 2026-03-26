import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { MOCK_USERS } from '../types/auth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { LogIn, ShieldCheck, UserCircle, Mail, Loader2 } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';

const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as any)?.from?.pathname || '/';

  const getRedirectPath = (role: string) => {
    if (from !== '/') return from;
    switch (role) {
      case 'salesperson': return '/sales-funnel';
      case 'whatsapp_manager': return '/twilio-messaging';
      default: return '/';
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    // For demo purposes, we find the user by email first to know their role for redirection
    const preCheckUser = MOCK_USERS.find(u => u.email.toLowerCase() === email.toLowerCase());
    
    const success = await login(email);
    if (success && preCheckUser) {
      navigate(getRedirectPath(preCheckUser.role), { replace: true });
    } else if (success) {
      // Fallback for non-mock users if any
      navigate(from, { replace: true });
    } else {
      setError('Invalid email address. Try one of the demo accounts.');
      setLoading(false);
    }
  };

  const handleQuickLogin = async (demoUser: typeof MOCK_USERS[0]) => {
    setLoading(true);
    setError(null);
    setEmail(demoUser.email);
    const success = await login(demoUser.email);
    if (success) {
      navigate(getRedirectPath(demoUser.role), { replace: true });
    } else {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 px-6 relative overflow-hidden">
      {/* Background Decorative Elements */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-[120px] animate-pulse"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-rose-500/10 rounded-full blur-[120px] animate-pulse [animation-delay:1s]"></div>
      
      <div className="w-full max-w-md relative z-10 space-y-8 animate-fade-in">
        <div className="text-center space-y-4">
          <div className="mx-auto h-16 w-16 rounded-3xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shadow-2xl shadow-indigo-500/10 mb-6">
            <ShieldCheck className="size-8 text-indigo-400" />
          </div>
          <h1 className="text-4xl font-bold text-slate-100 uppercase tracking-tight font-heading">Secure Portal</h1>
          <p className="text-sm text-slate-500 font-medium">LearnXR Platform Administration</p>
        </div>

        <form onSubmit={handleLogin} className="glass-card p-10 rounded-[40px] space-y-6 border-white/5 shadow-2xl shadow-black/40">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-400 ml-1">Corporate Email</Label>
              <div className="relative group">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-slate-600 transition-colors group-focus-within:text-indigo-400" />
                <Input 
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@learnxr.com"
                  className="h-12 pl-12 bg-slate-950/80 border-white/5 rounded-2xl text-xs focus:ring-indigo-500/10 focus:border-indigo-500/30 transition-all font-medium"
                  required
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="text-[10px] text-rose-500 font-bold uppercase tracking-widest text-center animate-shake">
              {error}
            </p>
          )}

          <Button 
            type="submit" 
            disabled={loading}
            className="w-full h-12 bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold rounded-2xl shadow-lg shadow-indigo-600/20 transition-all active:scale-[0.98]"
          >
            {loading ? <Loader2 className="size-5 animate-spin mx-auto" /> : 'Sign In'}
          </Button>

          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/5"></span></div>
            <div className="relative flex justify-center text-[9px] uppercase tracking-[0.2em] font-black text-slate-700"><span className="bg-[#020617] px-4">Demo Accounts</span></div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {MOCK_USERS.map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => handleQuickLogin(user)}
                className="flex flex-col items-start p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 hover:border-indigo-500/20 transition-all text-left group"
              >
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-500 group-hover:text-indigo-400">{user.role}</span>
                <span className="text-[10px] font-bold text-slate-300 mt-1">{user.name.split(' ')[0]}</span>
              </button>
            ))}
          </div>
        </form>

        <p className="text-center text-[10px] text-slate-700 font-black uppercase tracking-[0.3em]">
          &copy; {new Date().getFullYear()} LEARNXR GLOBAL
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
