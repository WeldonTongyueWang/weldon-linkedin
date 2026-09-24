import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, Loader2, MessageSquare } from 'lucide-react';

type DialogTone = 'info' | 'success' | 'warning' | 'danger';

type BaseDialogOptions = {
  title?: string;
  message: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type AppAlertOptions = BaseDialogOptions;

export type AppConfirmOptions = BaseDialogOptions;

export type AppPromptOptions = BaseDialogOptions & {
  defaultValue?: string;
  placeholder?: string;
  inputLabel?: string;
  required?: boolean;
};

type DialogRequest =
  | {
      kind: 'alert';
      options: AppAlertOptions;
      resolve: () => void;
    }
  | {
      kind: 'confirm';
      options: AppConfirmOptions;
      resolve: (value: boolean) => void;
    }
  | {
      kind: 'prompt';
      options: AppPromptOptions;
      resolve: (value: string | null) => void;
    };

type AppDialogContextValue = {
  alert: (options: string | AppAlertOptions) => Promise<void>;
  confirm: (options: string | AppConfirmOptions) => Promise<boolean>;
  prompt: (options: string | AppPromptOptions) => Promise<string | null>;
};

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

const normalizeAlertOptions = (options: string | AppAlertOptions): AppAlertOptions =>
  typeof options === 'string' ? { message: options } : options;

const normalizeConfirmOptions = (options: string | AppConfirmOptions): AppConfirmOptions =>
  typeof options === 'string' ? { message: options } : options;

const normalizePromptOptions = (options: string | AppPromptOptions): AppPromptOptions =>
  typeof options === 'string' ? { message: options } : options;

const defaultTitleByKind: Record<DialogRequest['kind'], string> = {
  alert: 'Notice',
  confirm: 'Confirm Action',
  prompt: 'Enter Details',
};

const defaultConfirmLabelByKind: Record<DialogRequest['kind'], string> = {
  alert: 'OK',
  confirm: 'Confirm',
  prompt: 'Save',
};

const toneClasses: Record<DialogTone, { icon: string; button: string; ring: string }> = {
  info: {
    icon: 'text-sky-600',
    button: 'bg-sky-600 hover:bg-sky-700',
    ring: 'focus:ring-sky-500',
  },
  success: {
    icon: 'text-emerald-600',
    button: 'bg-emerald-600 hover:bg-emerald-700',
    ring: 'focus:ring-emerald-500',
  },
  warning: {
    icon: 'text-amber-600',
    button: 'bg-amber-600 hover:bg-amber-700',
    ring: 'focus:ring-amber-500',
  },
  danger: {
    icon: 'text-red-600',
    button: 'bg-red-600 hover:bg-red-700',
    ring: 'focus:ring-red-500',
  },
};

const getTone = (request: DialogRequest | null): DialogTone => {
  if (!request) return 'info';
  return request.options.tone || (request.kind === 'alert' ? 'info' : request.kind === 'confirm' ? 'warning' : 'info');
};

const DialogIcon: React.FC<{ request: DialogRequest; tone: DialogTone }> = ({ request, tone }) => {
  const className = `w-6 h-6 mr-3 ${toneClasses[tone].icon}`;
  if (tone === 'success') return <CheckCircle2 className={className} />;
  if (tone === 'danger' || tone === 'warning') return <AlertTriangle className={className} />;
  if (request.kind === 'prompt') return <MessageSquare className={className} />;
  return <Info className={className} />;
};

export const AppDialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [promptValue, setPromptValue] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  const activeRequest = queue[0] || null;
  const activeTone = getTone(activeRequest);

  useEffect(() => {
    if (!activeRequest || activeRequest.kind !== 'prompt') {
      setPromptValue('');
      return;
    }
    setPromptValue(activeRequest.options.defaultValue || '');
  }, [activeRequest]);

  const closeActiveRequest = useCallback(() => {
    setQueue((current) => current.slice(1));
    setIsResolving(false);
  }, []);

  const enqueue = useCallback((request: DialogRequest) => {
    setQueue((current) => [...current, request]);
  }, []);

  const alert = useCallback((options: string | AppAlertOptions) => {
    const normalized = normalizeAlertOptions(options);
    return new Promise<void>((resolve) => {
      enqueue({
        kind: 'alert',
        options: normalized,
        resolve,
      });
    });
  }, [enqueue]);

  const confirm = useCallback((options: string | AppConfirmOptions) => {
    const normalized = normalizeConfirmOptions(options);
    return new Promise<boolean>((resolve) => {
      enqueue({
        kind: 'confirm',
        options: normalized,
        resolve,
      });
    });
  }, [enqueue]);

  const prompt = useCallback((options: string | AppPromptOptions) => {
    const normalized = normalizePromptOptions(options);
    return new Promise<string | null>((resolve) => {
      enqueue({
        kind: 'prompt',
        options: normalized,
        resolve,
      });
    });
  }, [enqueue]);

  const handleCancel = useCallback(() => {
    if (!activeRequest || isResolving) return;
    if (activeRequest.kind === 'alert') {
      activeRequest.resolve();
    } else if (activeRequest.kind === 'confirm') {
      activeRequest.resolve(false);
    } else {
      activeRequest.resolve(null);
    }
    closeActiveRequest();
  }, [activeRequest, closeActiveRequest, isResolving]);

  const handleConfirm = useCallback(async () => {
    if (!activeRequest || isResolving) return;
    if (activeRequest.kind === 'prompt') {
      const nextValue = promptValue;
      if (activeRequest.options.required && !nextValue.trim()) return;
      activeRequest.resolve(nextValue);
      closeActiveRequest();
      return;
    }
    if (activeRequest.kind === 'confirm') {
      activeRequest.resolve(true);
      closeActiveRequest();
      return;
    }
    setIsResolving(true);
    try {
      activeRequest.resolve();
    } finally {
      closeActiveRequest();
    }
  }, [activeRequest, closeActiveRequest, isResolving, promptValue]);

  useEffect(() => {
    if (!activeRequest) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const target = event.target as HTMLElement | null;
        if (target && target.tagName === 'TEXTAREA') return;
        event.preventDefault();
        void handleConfirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeRequest, handleCancel, handleConfirm]);

  const contextValue = useMemo<AppDialogContextValue>(
    () => ({
      alert,
      confirm,
      prompt,
    }),
    [alert, confirm, prompt]
  );

  const confirmDisabled =
    activeRequest?.kind === 'prompt' && Boolean(activeRequest.options.required) && !promptValue.trim();
  const dialogRoot = typeof document === 'undefined' ? null : document.body;

  return (
    <AppDialogContext.Provider value={contextValue}>
      {children}
      {activeRequest && dialogRoot && createPortal(
        <div className="fixed inset-0 z-[200] flex min-h-[100vh] min-h-[100dvh] items-center justify-center overflow-y-auto bg-slate-950/65 px-4 py-6 backdrop-blur-md animate-in fade-in sm:p-6">
          <div className="max-h-[calc(100dvh-3rem)] w-full max-w-md overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 shadow-2xl sm:p-6">
            <div className="mb-4 flex items-center text-slate-900">
              <DialogIcon request={activeRequest} tone={activeTone} />
              <h2 className="text-lg font-bold">
                {activeRequest.options.title || defaultTitleByKind[activeRequest.kind]}
              </h2>
            </div>
            <p className="mb-5 whitespace-pre-line break-words text-sm font-medium leading-relaxed text-slate-600">
              {activeRequest.options.message}
            </p>
            {activeRequest.kind === 'prompt' && (
              <div className="mb-5 space-y-2">
                {activeRequest.options.inputLabel && (
                  <label className="block text-xs font-bold uppercase tracking-widest text-slate-500">
                    {activeRequest.options.inputLabel}
                  </label>
                )}
                <input
                  autoFocus
                  type="text"
                  value={promptValue}
                  onChange={(event) => setPromptValue(event.target.value)}
                  placeholder={activeRequest.options.placeholder}
                  className={`w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium text-slate-800 outline-none transition focus:ring-2 ${toneClasses[activeTone].ring}`}
                />
              </div>
            )}
            <div className="flex justify-end gap-3">
              {activeRequest.kind !== 'alert' && (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="rounded-lg px-4 py-2 text-sm font-bold text-slate-600 transition hover:bg-slate-100"
                >
                  {activeRequest.options.cancelLabel || 'Cancel'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={Boolean(confirmDisabled || isResolving)}
                className={`rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${toneClasses[activeTone].button}`}
              >
                {isResolving && activeRequest.kind === 'alert' ? (
                  <span className="inline-flex items-center">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Working...
                  </span>
                ) : (
                  activeRequest.options.confirmLabel || defaultConfirmLabelByKind[activeRequest.kind]
                )}
              </button>
            </div>
          </div>
        </div>,
        dialogRoot
      )}
    </AppDialogContext.Provider>
  );
};

export const useAppDialog = (): AppDialogContextValue => {
  const context = useContext(AppDialogContext);
  if (!context) {
    throw new Error('useAppDialog must be used within AppDialogProvider');
  }
  return context;
};
