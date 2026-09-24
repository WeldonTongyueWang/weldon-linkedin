
import React from 'react';
import { Layers, Database, Archive, Factory, RefreshCcw, User } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  isSyncing?: boolean;
  onForceSync?: () => void;
  allowedTabs: string[];
  currentUser?: string;
  syncStatusText?: string;
  syncStatusTone?: 'neutral' | 'success' | 'warning' | 'danger';
}

export const Layout: React.FC<LayoutProps> = ({
  children,
  activeTab,
  onTabChange,
  isSyncing,
  onForceSync,
  allowedTabs,
  currentUser,
  syncStatusText,
  syncStatusTone = 'neutral',
}) => {
  const normalizedUser = String(currentUser || '').trim();
  const activeUserLabel = normalizedUser || 'Unknown user';
  const activeUserShortLabel = normalizedUser.includes('@')
    ? (normalizedUser.split('@')[0] || 'Unknown user')
    : activeUserLabel;
  const syncStatusClass =
    syncStatusTone === 'success'
      ? 'text-emerald-200'
      : syncStatusTone === 'warning'
        ? 'text-amber-200'
        : syncStatusTone === 'danger'
          ? 'text-red-200'
          : 'text-slate-400';
  
  // Definition of all possible tabs
  const allTabs = [
    { id: 'master', label: 'Master Data', icon: Database },
    { id: 'inventory', label: 'Inventory Manager', icon: Archive },
    { id: 'manufacturing', label: 'Manufacturing Planning', icon: Layers },
  ];

  // Filter based on permissions
  const visibleTabs = allTabs.filter(t => allowedTabs.includes(t.id));

  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <header className="bg-slate-900 text-white p-3 sm:p-4 shadow-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 md:gap-0">
          <div className="flex items-center space-x-2 w-full md:w-auto">
            <div className="flex items-center gap-2.5 flex-shrink-0" aria-label="Weldon Manufacturing Ltd">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 shadow-sm">
                <Factory className="h-5 w-5 text-white" aria-hidden="true" />
              </span>
              <span className="hidden sm:block leading-tight">
                <span className="block text-sm font-bold tracking-wide text-white">Weldon Manufacturing Ltd</span>
                <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Demo workspace</span>
              </span>
            </div>
            <div className="ml-auto md:ml-4 flex items-center">
              <div className="relative hidden lg:block w-[88px] h-11 flex-shrink-0">
                <button 
                    onClick={onForceSync}
                    disabled={isSyncing}
                    className={`absolute left-[22px] top-0 flex items-center justify-center w-11 h-11 rounded-full transition-all border ${
                        isSyncing 
                        ? 'text-blue-400 border-blue-900/50 bg-blue-900/20 cursor-not-allowed' 
                        : 'text-slate-400 border-slate-700 hover:text-white hover:bg-slate-800 hover:border-slate-600'
                    }`}
                    title={isSyncing ? 'Refreshing local demo' : 'Refresh local demo data'}
                >
                    <RefreshCcw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                </button>
                {syncStatusText && (
                  <div className={`absolute left-0 top-[31px] w-[88px] overflow-hidden truncate whitespace-nowrap text-center text-[9px] font-semibold leading-none ${syncStatusClass}`}>
                    {syncStatusText}
                  </div>
                )}
              </div>
              <button 
                  onClick={onForceSync}
                  disabled={isSyncing}
                  className={`flex items-center justify-center w-11 h-11 rounded-full transition-all border lg:hidden ${
                      isSyncing 
                      ? 'text-blue-400 border-blue-900/50 bg-blue-900/20 cursor-not-allowed' 
                      : 'text-slate-400 border-slate-700 hover:text-white hover:bg-slate-800 hover:border-slate-600'
                  }`}
                  title={isSyncing ? 'Refreshing local demo' : 'Refresh local demo data'}
              >
                  <RefreshCcw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div
              className="ml-1 inline-flex max-w-[108px] items-center gap-1 rounded-full border border-blue-700/60 bg-blue-900/30 px-1.5 py-0.5 whitespace-nowrap"
              title={activeUserLabel}
            >
              <User className="w-2.5 h-2.5 text-blue-200 flex-shrink-0" />
              <span className="truncate text-[11px] font-semibold text-white">{activeUserShortLabel}</span>
            </div>
          </div>
          <nav className="flex space-x-1 overflow-x-auto w-full md:w-auto pb-1 md:pb-0 whitespace-nowrap">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={`flex shrink-0 items-center px-4 py-3 rounded-md text-sm font-medium transition-colors whitespace-nowrap min-h-11 ${
                    isActive 
                      ? 'bg-blue-600 text-white' 
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 mr-2" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 relative">
        {children}
      </main>
      <footer className="bg-slate-200 p-4 text-center text-slate-500 text-xs font-medium">
          Weldon Manufacturing Ltd • Browser-local demonstration • Synthetic data only
      </footer>
    </div>
  );
};
