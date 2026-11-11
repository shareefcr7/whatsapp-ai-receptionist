import { createContext, useContext, useEffect } from 'react';
import { Outlet } from 'react-router';
import { ErrorState, Skeleton } from '../components/ui';
import { Login } from '../pages/Login';
import { apiRequest, SESSION_EXPIRED, useApi } from './api';
import type { Staff } from './api';

interface Auth {
  /** Null only when the backend has no database, where there is nothing to sign in to. */
  staff: Staff | null;
  isAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside AuthGate');
  return auth;
}

/** Nothing below this renders, or fetches, until the backend confirms a session. */
export function AuthGate() {
  const { result, error, loading, refetch } = useApi<Staff>('/auth/me');

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED, refetch);
    return () => window.removeEventListener(SESSION_EXPIRED, refetch);
  }, [refetch]);

  if (loading) {
    return (
      <div className="mx-auto max-w-md pt-24">
        <Skeleton />
      </div>
    );
  }
  if (error?.code === 'UNAUTHENTICATED') return <Login onSignedIn={refetch} />;
  if (error && error.code !== 'DATABASE_NOT_CONFIGURED') {
    return (
      <div className="mx-auto max-w-md pt-24">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const staff = result?.data ?? null;
  const signOut = async () => {
    await apiRequest('/auth/logout', { method: 'POST' });
    refetch();
  };
  return (
    <AuthContext.Provider value={{ staff, isAdmin: staff?.role === 'admin', signOut }}>
      <Outlet />
    </AuthContext.Provider>
  );
}
