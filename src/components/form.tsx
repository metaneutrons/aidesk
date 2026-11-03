"use client";
import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
// The parts that the forms of the settings are made of, so that they look and behave alike: a group (a title, a
// card of rows and a note), a row (what it is on the left, the control on the right), a switch, a number with its
// unit, a segmented choice, a disclosure for what most people leave alone and the bar that holds the buttons of a form.

// A card of rows. The title stands above the card and the note below it, as in the lists of a phone's settings.
export function Group({
  title,
  note,
  children,
}: {
  title?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="group" role="group" aria-labelledby={title ? `${id}-title` : undefined}>
      {title && (
        <div id={`${id}-title`} className="group-title">
          {title}
        </div>
      )}
      <div className="group-card">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </div>
  );
}

export interface ControlProps {
  id: string;
  "aria-describedby": string | undefined;
}

// One line of a group: the label on the left (a real label of the control, so a click on it reaches the control) and
// the control on the right. The control is drawn by the function, which gets the attributes that tie it to the label
// and to the hint. A hint is a note under the label, not part of its name.
export function Row({
  label,
  hint,
  stacked = false,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  // The control takes the whole width below the label (a text, a list).
  stacked?: boolean;
  children: (props: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={`row${stacked ? " stacked" : ""}`}>
      <div className="row-label">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <small id={hintId} className="row-hint">
            {hint}
          </small>
        )}
      </div>
      <div className="row-control">{children({ id, "aria-describedby": hintId })}</div>
    </div>
  );
}

// A switch is a checkbox, so it keeps its role, its keyboard handling and its name; only the look differs.
export function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      {(props) => (
        <input
          {...props}
          type="checkbox"
          className="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      )}
    </Row>
  );
}

// A number (or another short value) with its unit behind it.
export function Unit({ children, unit }: { children: ReactNode; unit: string }) {
  return (
    <span className="unit">
      {children}
      <span className="unit-name" aria-hidden>
        {unit}
      </span>
    </span>
  );
}

// A choice of a few values in one line, for two to four options.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className={option.value === value ? "selected" : undefined}>
          <input
            type="radio"
            name={name}
            checked={option.value === value}
            onChange={() => {
              onChange(option.value);
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

// Rows that most people leave alone, closed until they are asked for. It sits inside a group like a row.
export function Disclosure({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="disclosure">
      <summary>
        <span className="row-label">
          <span>{title}</span>
          {hint && <small className="row-hint">{hint}</small>}
        </span>
        <ChevronRight className="disclosure-chevron" size={16} aria-hidden />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

// The buttons of a form, held at the lower edge of the topic while the form is long, with what is to be said about
// the form on the left.
export function Actions({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="actions-bar">
      <span className="actions-status" role="status">
        {status}
      </span>
      {children}
    </div>
  );
}
