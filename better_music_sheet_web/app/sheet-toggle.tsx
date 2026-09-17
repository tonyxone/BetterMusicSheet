"use client";

// Switches the sheet viewers between what the site produced and what the
// visitor handed it. Shared by the result page and the Play page so the two
// read as the same control, and because "which copy am I looking at" is the
// same question in both places.
//
// Geometry is identical between the two: the annotated PDF is the uploaded
// one with names drawn on top (see annotate.py), so Play keeps highlighting
// and click-to-seek working on either.

export type SheetVariant = "annotated" | "original";

export function SheetToggle({
  value,
  onChange,
  /** Why the original can't be shown, if it can't - a photo upload, or an
   * upload no longer in storage. Disables the control and explains itself
   * rather than vanishing, so the option doesn't look like it never existed. */
  unavailable,
  dark = false,
}: {
  value: SheetVariant;
  onChange: (next: SheetVariant) => void;
  unavailable?: string | null;
  dark?: boolean;
}) {
  const options: { id: SheetVariant; label: string; title: string }[] = [
    { id: "annotated", label: "Annotated", title: "Show the sheet with note names" },
    { id: "original", label: "Original", title: unavailable ?? "Show the sheet as you uploaded it" },
  ];

  return (
    <div className={`sheet-toggle${dark ? " dark" : ""}`} role="group" aria-label="Sheet version">
      {options.map((option) => {
        const blocked = option.id === "original" && !!unavailable;
        return (
          <button
            key={option.id}
            type="button"
            className={`sheet-toggle-option${value === option.id ? " active" : ""}`}
            // aria-pressed, not a radio group: these are two states of one
            // view, and a screen reader should hear "pressed" the same way a
            // sighted reader sees the filled half.
            aria-pressed={value === option.id}
            disabled={blocked}
            title={option.title}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
