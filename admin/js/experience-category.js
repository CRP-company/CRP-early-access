const CATEGORIES = Object.freeze({
  developer: {
    label: "Developer / Tech enthusiast",
    className: "experience-badge--developer",
  },
  everyday_user: {
    label: "Everyday user",
    className: "experience-badge--everyday",
  },
  new_to_technology: {
    label: "New to technology",
    className: "experience-badge--new",
  },
});

export function experienceCategoryDisplay(value) {
  if (Object.hasOwn(CATEGORIES, value)) return CATEGORIES[value];
  return {
    label: "Not specified",
    className: "experience-badge--unspecified",
  };
}
