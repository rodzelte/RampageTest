import { useEffect, useId, useRef, type ReactNode } from 'react';

export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <h2 id={id}>{title}</h2>
        {children}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
