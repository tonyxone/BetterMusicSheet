"use client";

// Letter names (C D E...), jianpu numbers (1 2 3..., see lib/notation.ts),
// or solfège (do re mi...). Styled as the Annotated/Original switch beside
// it, since it is the same kind of choice about one view.

import type { Notation } from "@/lib/notation";

export function NotationToggle({ value, onChange, dark = false }: {
  value: Notation;
  onChange: (next: Notation) => void;
  dark?: boolean;
}) {
  const options: { id: Notation; label: string; title: string }[] = [
    { id: "letters", label: "CDE", title: "Letter names: C D E F G A B" },
    { id: "numbers", label: "123", title: "Jianpu (numbered notation, 簡譜): 1 2 3 4 5 6 7 for C D E F G A B" },
    { id: "solfege", label: "DoReMi", title: "Solfège: do re mi fa so la si for C D E F G A B" },
  ];
  return (
    <div className={`sheet-toggle${dark ? " dark" : ""}`} role="group" aria-label="Note name notation">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`sheet-toggle-option${value === option.id ? " active" : ""}`}
          aria-pressed={value === option.id}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
