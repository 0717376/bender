// Stable per-project accent dots (Halo palette). Derived from the project id so a
// project keeps the same colour without the backend storing one.
export const PROJECT_COLORS = ["#D2568C", "#5A78D6", "#3FA888", "#D6914A", "#9B6DD6", "#4FA8C0", "#C8694A"];

export const projectColor = (id: number) =>
  PROJECT_COLORS[((id % PROJECT_COLORS.length) + PROJECT_COLORS.length) % PROJECT_COLORS.length];
