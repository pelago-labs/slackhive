'use client';

/**
 * @fileoverview Client-side auth context — provides role info to components.
 *
 * Roles: superadmin > admin > editor > viewer
 * - canEdit: editor, admin, superadmin (can create/edit agents, jobs, settings)
 * - canManageUsers: admin, superadmin only (can create/delete users)
 *
 * @module web/lib/auth-context
 */

import { createContext, useContext, useEffect, useState } from 'react';

interface AuthState {
  username: string;
  role: 'superadmin' | 'admin' | 'editor' | 'viewer' | null;
  loading: boolean;
  /** Can create/edit/delete agents, jobs, settings, MCPs. */
  canEdit: boolean;
  /** Can create/delete users (admin + superadmin only). */
  canManageUsers: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  username: '', role: null, loading: true, canEdit: false, canManageUsers: false, logout: async () => {},
});

/**
 * Provides auth state to the component tree.
 *
 * @param {{ children: React.ReactNode }} props
 * @returns {JSX.Element}
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<AuthState['role']>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { setUsername(data.username); setRole(data.role); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const canEdit = role === 'superadmin' || role === 'admin' || role === 'editor';
  const canManageUsers = role === 'superadmin' || role === 'admin';

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider value={{ username, role, loading, canEdit, canManageUsers, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to access the current auth state.
 *
 * @returns {AuthState} Current auth state.
 */
export function useAuth(): AuthState {
  return useContext(AuthContext);
}
