import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './listbox-select.module.less';

export interface ListboxSelectOption {
  value: string;
  label: string;
}

interface ListboxSelectProps {
  value: string;
  options: ListboxSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Forwarded to the trigger so an external <label htmlFor> still labels the control. */
  id?: string;
  disabled?: boolean;
  /** Pin the menu side; by default the side with room is picked on open. */
  placement?: 'down' | 'up';
}

/** Keep the row height and menu max-height in sync with listbox-select.module.less. */
const MENU_ROW_HEIGHT = 34;
const MENU_MAX_HEIGHT = 280;

/**
 * Shared DOM listbox for the settings panels.
 *
 * Native <select> is not usable here: its popup is a separate CEF/Chromium window,
 * which JCEF fails to create on the first browser instance after a fresh install
 * (the very first click after reinstalling the plugin is swallowed and only an IDE
 * restart recovers it), and any CSS zoom write on an ancestor dismisses it. A DOM
 * listbox keeps the options inside the page, so it is always clickable.
 *
 * Same pattern as AiFeatureProviderModelPanel/FeatureSelect and DependencySection
 * /VersionSelect; this one is shared because the BasicConfigSection appearance
 * controls need an explicit up/down menu placement.
 */
const ListboxSelect = ({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
  placement,
}: ListboxSelectProps) => {
  const [open, setOpen] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<'down' | 'up'>(placement ?? 'down');
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // Measure before paint so the menu never flashes on the wrong side.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    if (placement) {
      setResolvedPlacement(placement);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    // getBoundingClientRect() and innerHeight are both viewport-space here, so the
    // comparison stays valid under the #app CSS zoom used for font scaling.
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const wanted = Math.min(options.length * MENU_ROW_HEIGHT + 8, MENU_MAX_HEIGHT);
    setResolvedPlacement(spaceBelow < wanted && spaceAbove > spaceBelow ? 'up' : 'down');
  }, [open, options.length, placement]);

  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={`${styles.trigger} ${open ? styles.open : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            closeAndRefocus();
          }
        }}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.value}>{selectedLabel}</span>
        <span className={`codicon codicon-chevron-down ${styles.arrow}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          className={`${styles.menu} ${resolvedPlacement === 'up' ? styles.menuUp : styles.menuDown}`}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.option} ${selected ? styles.selected : ''}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {selected && <span className="codicon codicon-check" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ListboxSelect;
