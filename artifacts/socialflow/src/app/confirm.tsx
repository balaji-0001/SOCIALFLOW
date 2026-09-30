import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { TriangleAlert } from 'lucide-react';

type ConfirmOptions = { title: string; description?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean };

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

/** Styled, accessible replacement for window.confirm. Resolves true only when the user confirms. */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(next);
  }), []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  };

  return <ConfirmContext.Provider value={confirm}>
    {children}
    <AlertDialog.Root open={options !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sfa-overlay sfa-overlay--top" />
        <AlertDialog.Content className="sfa-confirm" data-testid="dialog-confirm">
          {options?.destructive && <span className="sfa-confirm__icon" aria-hidden="true"><TriangleAlert size={20} /></span>}
          <AlertDialog.Title className="sfa-confirm__title">{options?.title}</AlertDialog.Title>
          <AlertDialog.Description className={options?.description ? 'sfa-confirm__desc' : 'sr-only'}>{options?.description ?? 'Please confirm this action.'}</AlertDialog.Description>
          <div className="sfa-confirm__actions">
            <AlertDialog.Cancel className="sfa-btn sfa-btn--secondary sfa-btn--md" data-testid="button-confirm-cancel">{options?.cancelLabel ?? 'Cancel'}</AlertDialog.Cancel>
            <AlertDialog.Action className={`sfa-btn sfa-btn--md ${options?.destructive ? 'sfa-btn--danger-solid' : 'sfa-btn--primary'}`} onClick={() => settle(true)} data-testid="button-confirm-ok">
              {options?.confirmLabel ?? 'Confirm'}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </ConfirmContext.Provider>;
}
