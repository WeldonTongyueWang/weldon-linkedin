import { createDemoDatabase, type DemoDatabase } from '../data/fixtures';

export const STORAGE_KEY = 'weldon-linkedin:demo:v2';

type StoreListener = () => void;
type StoreUpdater = (draft: DemoDatabase) => void | DemoDatabase;

const listeners = new Set<StoreListener>();

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const normalizeDatabase = (value: Partial<DemoDatabase>): DemoDatabase => ({
  schemaVersion: Number(value.schemaVersion) || 2,
  items: Array.isArray(value.items) ? value.items : [],
  products: Array.isArray(value.products) ? value.products : [],
  recipes: Array.isArray(value.recipes) ? value.recipes : [],
  categories: Array.isArray(value.categories) ? value.categories : [],
  rawComponentDisplayNames: Array.isArray(value.rawComponentDisplayNames)
    ? value.rawComponentDisplayNames
    : [],
  transactions: Array.isArray(value.transactions) ? value.transactions : [],
  rawComponentLots: Array.isArray(value.rawComponentLots) ? value.rawComponentLots : [],
  batches: Array.isArray(value.batches) ? value.batches : [],
  documents: Array.isArray(value.documents) ? value.documents : [],
  planningReports: Array.isArray(value.planningReports) ? value.planningReports : [],
});

const readPersistedState = (): DemoDatabase | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoDatabase> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeDatabase(parsed);
  } catch {
    return null;
  }
};

const persist = (state: DemoDatabase): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The demo remains usable in memory when browser storage is unavailable.
  }
};

let currentState = readPersistedState() ?? createDemoDatabase();
persist(currentState);

const emitChange = (): void => {
  listeners.forEach((listener) => listener());
};

export const getDemoSnapshot = (): DemoDatabase => currentState;

export const subscribeDemoStore = (listener: StoreListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const updateDemoStore = (updater: StoreUpdater): DemoDatabase => {
  const draft = clone(currentState);
  const result = updater(draft);
  currentState = normalizeDatabase((result || draft) as DemoDatabase);
  persist(currentState);
  emitChange();
  return currentState;
};

export const resetDemoStore = (): DemoDatabase => {
  currentState = createDemoDatabase();
  persist(currentState);
  emitChange();
  return currentState;
};

export const reloadDemoStore = (): DemoDatabase => {
  currentState = readPersistedState() ?? createDemoDatabase();
  persist(currentState);
  emitChange();
  return currentState;
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    currentState = readPersistedState() ?? createDemoDatabase();
    emitChange();
  });
}
