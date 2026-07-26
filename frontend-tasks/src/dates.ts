// Даты задач — календарные, без времени и без зоны. Бэкенд живёт по date.today()
// в TZ контейнера, поэтому и здесь считаем по локальному календарю: toISOString()
// отдаёт UTC и в Москве с полуночи до 03:00 показывал бы вчерашний день.

export const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const isoToday = (): string => iso(new Date());

export const isoShift = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return iso(d);
};
