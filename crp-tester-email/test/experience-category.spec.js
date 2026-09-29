import { describe, it, expect } from "vitest";
import { experienceCategoryDisplay } from "../../admin/js/experience-category.js";

describe("experienceCategoryDisplay", () => {
  it.each([
    ["developer", "Developer / Tech enthusiast", "experience-badge--developer"],
    ["everyday_user", "Everyday user", "experience-badge--everyday"],
    ["new_to_technology", "New to technology", "experience-badge--new"],
  ])("renders %s as a stable category label", (value, label, className) => {
    expect(experienceCategoryDisplay(value)).toEqual({ label, className });
  });

  it.each([undefined, null, "legacy-value", "toString"])(
    "handles missing or unknown value %s",
    (value) => {
    expect(experienceCategoryDisplay(value)).toEqual({
      label: "Not specified",
      className: "experience-badge--unspecified",
    });
    },
  );
});
