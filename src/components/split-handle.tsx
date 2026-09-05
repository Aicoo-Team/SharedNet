"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type SplitConfig = Readonly<{
  /** localStorage key that remembers the width across visits. */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}>;

export type SplitState = Readonly<{
  width: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  setWidth: (next: number) => void;
  reset: () => void;
  /** Apply to the workspace grid so `--split-width` drives its first column. */
  style: CSSProperties;
}>;

const KEYBOARD_STEP = 16;

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Storage can be unavailable (private mode, blocked); the width still works for this visit.
  }
}

export function useSplitWidth({
  defaultWidth,
  maxWidth,
  minWidth,
  storageKey,
}: SplitConfig): SplitState {
  const [width, setWidthState] = useState(defaultWidth);

  useEffect(() => {
    const stored = readStoredWidth(storageKey);
    if (stored !== null) setWidthState(clampWidth(stored, minWidth, maxWidth));
  }, [maxWidth, minWidth, storageKey]);

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next, minWidth, maxWidth);
      setWidthState(clamped);
      writeStoredWidth(storageKey, clamped);
    },
    [maxWidth, minWidth, storageKey],
  );

  const reset = useCallback(() => {
    setWidthState(defaultWidth);
    writeStoredWidth(storageKey, null);
  }, [defaultWidth, storageKey]);

  return {
    defaultWidth,
    maxWidth,
    minWidth,
    reset,
    setWidth,
    style: { "--split-width": `${width}px` } as CSSProperties,
    width,
  };
}

type SplitHandleProps = Readonly<{
  /** Accessible name, e.g. "Resize Rooms sidebar". */
  label: string;
  split: SplitState;
}>;

/**
 * A draggable vertical divider that sits over the sidebar's right border.
 * Drag with the pointer, nudge with the arrow keys, double-click to reset.
 */
export function SplitHandle({ label, split }: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startWidth: split.width,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    split.setWidth(active.startWidth + (event.clientX - active.startX));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
    switch (event.key) {
      case "ArrowLeft":
        split.setWidth(split.width - step);
        break;
      case "ArrowRight":
        split.setWidth(split.width + step);
        break;
      case "Home":
        split.setWidth(split.minWidth);
        break;
      case "End":
        split.setWidth(split.maxWidth);
        break;
      case "Enter":
        split.reset();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={split.maxWidth}
      aria-valuemin={split.minWidth}
      aria-valuenow={split.width}
      className="split-handle"
      data-dragging={dragging ? "true" : undefined}
      onDoubleClick={split.reset}
      onKeyDown={onKeyDown}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      role="separator"
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
    />
  );
}
