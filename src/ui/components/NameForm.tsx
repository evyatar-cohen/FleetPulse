// First screen: ask the dispatcher's name (shown to other dispatchers). Validated: trimmed, 1–40 characters.
import { useState, type FormEvent, type ReactElement } from 'react';

const MAX_NAME_LENGTH = 40;

export function NameForm({ onSubmit }: { onSubmit: (name: string) => void }): ReactElement {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const isValid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (isValid) onSubmit(trimmed);
  }

  return (
    <form className="name-form" onSubmit={handleSubmit}>
      <h1>FleetPulse</h1>
      <label>
        Your name (visible to other dispatchers)
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_NAME_LENGTH}
          autoFocus
        />
      </label>
      <button type="submit" disabled={!isValid}>
        Start
      </button>
    </form>
  );
}
