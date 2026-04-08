import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, UserRole } from '../types/auth';
import {
  getAuthInstance,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  fetchUserRole,
  fetchUserDisplayName,
  isAuthConfigured,
  type FirebaseUser,
} from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  firebaseUser: FirebaseUser | null;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; role?: string }>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function buildAppUser(fbUser: FirebaseUser): Promise<User> {
  const role = await fetchUserRole(fbUser.uid);
  const name = await fetchUserDisplayName(fbUser.uid, fbUser.displayName || fbUser.email?.split('@')[0]);

  return {
    id: fbUser.uid,
    email: fbUser.email || '',
    name,
    role: role as UserRole,
    photoURL: fbUser.photoURL || undefined,
  };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthConfigured()) {
      setIsLoading(false);
      return;
    }

    const auth = getAuthInstance();
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        setFirebaseUser(fbUser);
        const appUser = await buildAppUser(fbUser);
        setUser(appUser);
      } else {
        setFirebaseUser(null);
        setUser(null);
      }
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string; role?: string }> => {
    setIsLoading(true);
    try {
      const auth = getAuthInstance();
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const appUser = await buildAppUser(credential.user);
      setFirebaseUser(credential.user);
      setUser(appUser);
      setIsLoading(false);
      return { success: true, role: appUser.role };
    } catch (err: any) {
      setIsLoading(false);
      const code = err?.code || '';
      let message = 'An unexpected error occurred. Please try again.';
      if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        message = 'Invalid email or password.';
      } else if (code === 'auth/too-many-requests') {
        message = 'Too many attempts. Please try again later.';
      } else if (code === 'auth/user-disabled') {
        message = 'This account has been disabled.';
      } else if (code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      }
      return { success: false, error: message };
    }
  };

  const logout = () => {
    const auth = getAuthInstance();
    signOut(auth);
    setUser(null);
    setFirebaseUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, firebaseUser, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
