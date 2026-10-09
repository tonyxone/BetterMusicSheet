"use client";

// Letter names (C D E...), jianpu numbers (1 2 3..., see lib/notation.ts),
// or solfège (do re mi...). Styled as the Annotated/Original switch beside
// it, since it is the same kind of choice about one view.

import type { Notation } from "@/lib/notation";
import { useI18n } from "@/lib/i18n/client";

export function NotationToggle({ value, onChange, dark = false }: {
  value: Notation;
  onChange: (next: Notation) => void;
  dark?: boolean;
}) {
  const { m } = useI18n();
  const t = m.toggles;
  const options: { id: Notation; label: string; title: string }[] = [
    { id: "letters", label: "CDE", title: t.lettersTitle },
    { id: "numbers", label: "123", title: t.numbersTitle },
    { id: "solfege", label: "DoReMi", title: t.solfegeTitle },
  ];
  return (
    <div className={`sheet-toggle${dark ? " dark" : ""}`} role="group" aria-label={t.notation}>
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
