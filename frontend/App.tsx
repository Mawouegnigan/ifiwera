import React, { useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { UploadCloud, AlertTriangle, LayoutDashboard, LogOut } from 'lucide-react';
import LoginScreen from './LoginScreen';
import ImportWorkspace from './ImportWorkspace';
import AnomaliesDashboard from './AnomaliesDashboard';
import ReconciliationDashboard from './ReconciliationDashboard';
import { isAuthenticated, clearToken } from './lib/api';

interface Tenant {
  id: number;
  name: string;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(isAuthenticated());
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const navigate = useNavigate();

  function handleAuthenticated(payload: { tenant: Tenant }) {
    setTenant(payload.tenant);
    setAuthenticated(true);
    navigate('/import');
  }

  function handleLogout() {
    clearToken();
    setAuthenticated(false);
    setTenant(null);
    navigate('/');
  }

  if (!authenticated) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-[#1A2422]">
      <TopNav tenant={tenant} onLogout={handleLogout} />

      <Routes>
        <Route path="/import" element={<ImportWorkspace />} />
        <Route path="/anomalies" element={<AnomaliesDashboard />} />
        <Route path="/dashboard" element={<ReconciliationDashboard />} />
        <Route path="*" element={<Navigate to="/import" replace />} />
      </Routes>
    </div>
  );
}

function TopNav({ tenant, onLogout }: { tenant: Tenant | null; onLogout: () => void }) {
  const location = useLocation();

  return (
    <nav className="border-b border-[#2E3F3C] bg-[#202B29]">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <NavLink to="/import" icon={<UploadCloud size={15} />} label="Import" active={location.pathname === '/import'} />
          <NavLink to="/anomalies" icon={<AlertTriangle size={15} />} label="Suspens" active={location.pathname === '/anomalies'} />
          <NavLink
            to="/dashboard"
            icon={<LayoutDashboard size={15} />}
            label="Tableau de bord"
            active={location.pathname === '/dashboard'}
          />
        </div>
        <div className="flex items-center gap-4">
          {tenant && <span className="text-xs text-[#9FB0A9]">{tenant.name}</span>}
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-xs text-[#9FB0A9] hover:text-[#E4E7E2] transition-colors"
          >
            <LogOut size={14} /> Déconnexion
          </button>
        </div>
      </div>
    </nav>
  );
}

function NavLink({ to, icon, label, active }: { to: string; icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-[#263531] text-[#4FBF9F]' : 'text-[#9FB0A9] hover:text-[#E4E7E2]'
      }`}
    >
      {icon} {label}
    </Link>
  );
}