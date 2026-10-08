import { useState, type FormEvent, type KeyboardEvent } from 'react';

interface InlineTextCellProps {
  /** Current persisted value; blank means nothing has been entered yet. */
  value: string;
  /** Accessible name for the trigger and the input. */
  label: string;
  /** Placeholder shown while the field is still empty. */
  placeholder: string;
  /** Maximum accepted length, mirrored onto the input. */
  maxLength?: number;
  /**
   * Persists the new value through the record update path. Resolving means the value was
   * saved; rejecting keeps the previous value on screen and reports the reason.
   */
  onSave: (next: string) => Promise<void>;
}

/**
 * A single-line field edited directly in a table cell.
 *
 * The read state is a button rather than bare text so the cell is a real control: it is
 * keyboard reachable, and being a button keeps the row's double-click-to-open-detail rule from
 * firing on top of it. The edit state is a plain input committed with Enter or blur and
 * abandoned with Escape — a failed save never loses what was typed.
 */
export default function InlineTextCell({
  value,
  label,
  placeholder,
  maxLength = 200,
  onSave,
}: InlineTextCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const trimmed = value.trim();

  const beginEdit = () => {
    setDraft(value);
    setError('');
    setEditing(true);
  };

  /** Commits only when the text actually changed, so a click-through does not write a revision. */
  const commit = async () => {
    if (saving) return;
    const next = draft.trim();
    if (next === trimmed) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(next);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setError('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  // Escape must not reach the row; blur finishes the edit the same way Enter does.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void commit();
  };

  if (editing) {
    return (
      <form
        className={`inline-edit-form${error ? ' inline-edit-failed' : ''}`}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
      >
        <input
          className="inline-edit-input"
          aria-label={label}
          autoFocus
          defaultValue={draft}
          maxLength={maxLength}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
        />
        {error && <span className="inline-edit-error">{error}</span>}
      </form>
    );
  }

  return (
    <button
      type="button"
      className={`inline-edit-trigger${trimmed ? '' : ' inline-edit-empty'}`}
      aria-label={label}
      title={error || trimmed || placeholder}
      onClick={beginEdit}
    >
      {trimmed || <span className="inline-edit-placeholder">{placeholder}</span>}
    </button>
  );
}
