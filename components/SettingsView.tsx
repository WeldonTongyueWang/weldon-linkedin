import React from 'react';
import {
  CheckCircle2,
  Eye,
  Info,
  MinusCircle,
  ShieldCheck,
  Users,
} from 'lucide-react';

import {
  ACCESS_SECTIONS,
  DEPARTMENT_ACCESS_PROFILES,
  getSectionPermission,
  type DepartmentFunctionId,
  type PermissionLevel,
} from '../config/departmentAccess';

const PERMISSION_DETAILS: Record<
  PermissionLevel,
  {
    label: string;
    description: string;
    className: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  use: {
    label: 'Use',
    description: 'Can view and work in this area',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: CheckCircle2,
  },
  view: {
    label: 'View',
    description: 'Read-only access',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
    icon: Eye,
  },
  none: {
    label: 'None',
    description: 'No access in a production setup',
    className: 'border-slate-200 bg-slate-100 text-slate-500',
    icon: MinusCircle,
  },
};

const PermissionBadge: React.FC<{ level: PermissionLevel }> = ({ level }) => {
  const details = PERMISSION_DETAILS[level];
  const Icon = details.icon;

  return (
    <span
      className={`inline-flex min-w-[72px] items-center justify-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${details.className}`}
      title={details.description}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {details.label}
    </span>
  );
};

export const SettingsView: React.FC = () => {
  const [selectedFunctionId, setSelectedFunctionId] = React.useState<DepartmentFunctionId>(
    DEPARTMENT_ACCESS_PROFILES[0].id,
  );

  const selectedProfile =
    DEPARTMENT_ACCESS_PROFILES.find((profile) => profile.id === selectedFunctionId) ??
    DEPARTMENT_ACCESS_PROFILES[0];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-lg shadow border border-slate-200">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="flex items-center text-xl font-bold text-slate-800">
              <Users className="mr-2 h-6 w-6 text-blue-600" aria-hidden="true" />
              Function Access Preview
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-500">
              Select a business function to preview how the retained workflows could be shared
              across a manufacturing team.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Read-only preview
          </span>
        </div>

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
          <p>
            These profiles are illustrative only. They do not create accounts or enforce access.
            The public demo remains fully editable, and all changes stay in each visitor&apos;s
            browser-local storage.
          </p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow border border-slate-200">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <aside className="rounded-lg border border-slate-200 p-3" aria-label="Business functions">
            <div className="px-1 pb-2 text-xs font-semibold text-slate-600">Select Function</div>
            <div className="space-y-1">
              {DEPARTMENT_ACCESS_PROFILES.map((profile) => {
                const isSelected = profile.id === selectedProfile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedFunctionId(profile.id)}
                    className={`w-full rounded border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                      isSelected
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                    }`}
                  >
                    {profile.displayName}
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="space-y-4 rounded-lg border border-slate-200 p-4 md:col-span-2">
            <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-400">
                  Selected function
                </div>
                <h3 className="mt-1 text-lg font-bold text-slate-800">
                  {selectedProfile.displayName}
                </h3>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Permission legend">
                {(['use', 'view', 'none'] as const).map((level) => (
                  <PermissionBadge key={level} level={level} />
                ))}
              </div>
            </div>

            <div className="overflow-hidden rounded border border-slate-200">
              <div className="bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                Top-Level Tabs
              </div>
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-3">
                {ACCESS_SECTIONS.map((section) => (
                  <div
                    key={section.id}
                    className="flex min-h-[72px] items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                  >
                    <span className="text-sm font-medium text-slate-700">{section.label}</span>
                    <PermissionBadge level={getSectionPermission(selectedProfile, section)} />
                  </div>
                ))}
              </div>
            </div>

            <div className="overflow-hidden rounded border border-slate-200">
              <div className="bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                Sub-Tab Permissions
              </div>
              <div className="max-h-[540px] space-y-5 overflow-auto p-3">
                {ACCESS_SECTIONS.map((section) => (
                  <div key={section.id} className="space-y-2">
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      {section.label}
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {section.features.map((feature) => (
                        <div
                          key={feature.id}
                          className="flex min-h-[46px] items-center justify-between gap-3 rounded border border-slate-200 px-3 py-2"
                        >
                          <span className="text-xs font-medium text-slate-700">
                            {feature.label}
                          </span>
                          <PermissionBadge level={selectedProfile.permissions[feature.id]} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded border border-slate-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium text-slate-700">Release quarantine</div>
                <div className="text-xs text-slate-400">Illustrative production action</div>
              </div>
              <span
                className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold ${
                  selectedProfile.canReleaseQuarantine
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-slate-100 text-slate-500'
                }`}
              >
                {selectedProfile.canReleaseQuarantine ? (
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <MinusCircle className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {selectedProfile.canReleaseQuarantine ? 'Included' : 'Not included'}
              </span>
            </div>

            <p className="text-xs leading-relaxed text-slate-400">
              Use means the function could view and work in the workflow. View means read-only.
              None means the workflow would not normally be available to that function.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
};
