import {
  Building2,
  CalendarDays,
  Coins,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  MessagesSquare,
  Settings,
  Tags,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { useSystemStatus } from '../lib/useSystemStatus';
import { StatusDot } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { to: '/leads', label: 'Leads', icon: UserPlus },
  { to: '/appointments', label: 'Appointments', icon: CalendarDays },
  { to: '/business-information', label: 'Business Information', icon: Building2 },
  { to: '/services', label: 'Services', icon: Tags },
  { to: '/usage-costs', label: 'Usage & Costs', icon: Coins },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Sidebar({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-rail text-stone-300">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
          <MessageSquareText className="size-4.5" aria-hidden />
        </span>
        <span className="text-sm font-semibold text-white">AI Receptionist</span>
        {onClose && (
          <button onClick={onClose} aria-label="Close menu" className="ml-auto rounded-lg p-1.5 hover:bg-rail-soft">
            <X className="size-5" aria-hidden />
          </button>
        )}
      </div>
      <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-rail-soft text-white' : 'hover:bg-rail-soft/60 hover:text-white'
              }`
            }
          >
            <Icon className="size-4.5 shrink-0" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
      <p className="px-5 py-4 text-xs text-stone-500">Internal admin</p>
    </div>
  );
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const { api, database } = useSystemStatus();
  const { staff, signOut } = useAuth();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const title = NAV.find((item) => item.to === pathname)?.label ?? 'Not found';

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="min-h-dvh lg:pl-60">
      <aside className="fixed inset-y-0 left-0 hidden w-60 lg:block">
        <Sidebar />
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 max-w-[85vw]">
            <Sidebar onClose={() => setMenuOpen(false)} />
          </div>
        </div>
      )}

      <div className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-stone-200 bg-white/90 px-4 backdrop-blur sm:px-6">
        <button onClick={() => setMenuOpen(true)} aria-label="Open menu" className="-ml-1 rounded-lg p-1.5 hover:bg-stone-100 lg:hidden">
          <Menu className="size-5" aria-hidden />
        </button>
        <span className="truncate text-sm font-medium text-stone-700">{title}</span>
        <div className="ml-auto flex items-center gap-4 text-xs text-stone-600" aria-live="polite">
          <span className="flex items-center gap-1.5" title={`Backend API: ${api.detail}`}>
            <StatusDot tone={api.tone} /> API<span className="sr-only">: {api.detail}</span>
          </span>
          <span className="flex items-center gap-1.5" title={`Database: ${database.detail}`}>
            <StatusDot tone={database.tone} /> Database<span className="sr-only">: {database.detail}</span>
          </span>
          {staff && (
            <span className="flex items-center gap-2 border-l border-stone-200 pl-4">
              <span className="hidden font-medium text-stone-700 sm:inline" title={`${staff.email} (${staff.role})`}>
                {staff.fullName}
              </span>
              {signOutFailed && <span role="alert" className="text-red-700">Sign-out failed</span>}
              <button
                onClick={() => {
                  setSignOutFailed(false);
                  signOut().catch(() => setSignOutFailed(true));
                }}
                className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 font-medium hover:bg-stone-100"
              >
                <LogOut className="size-3.5" aria-hidden /> Sign out
              </button>
            </span>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
