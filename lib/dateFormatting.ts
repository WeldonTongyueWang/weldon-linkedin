const BRITISH_LOCALE = 'en-GB';

type DateInput = Date | string | number | null | undefined;

const dateFormatter = new Intl.DateTimeFormat(BRITISH_LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat(BRITISH_LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat(BRITISH_LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const parseDateInput = (value: DateInput): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const rawValue = String(value).trim();
  if (!rawValue) return null;

  const dateOnlyMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const formatBritishDate = (value: DateInput, fallback = ''): string => {
  const parsed = parseDateInput(value);
  return parsed ? dateFormatter.format(parsed) : fallback;
};

export const formatBritishTime = (value: DateInput, fallback = ''): string => {
  const parsed = parseDateInput(value);
  return parsed ? timeFormatter.format(parsed) : fallback;
};

export const formatBritishDateTime = (value: DateInput, fallback = ''): string => {
  const parsed = parseDateInput(value);
  return parsed ? dateTimeFormatter.format(parsed) : fallback;
};
