import type { Editor } from '../core/editor';
import type { Viewport } from '../core/viewport';

export interface ToolPointer {
  /** Document coordinates (float). */
  x: number;
  y: number;
  /** View (CSS px) coordinates. */
  sx: number;
  sy: number;
  pressure: number;
  shift: boolean;
  alt: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  button: number;
  pointerType: string;
}

export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Single-key shortcut (lowercase). */
  readonly key: string;
  readonly icon: string;
  cursor(): string;
  down?(p: ToolPointer): void;
  move?(p: ToolPointer): void;
  up?(p: ToolPointer): void;
  /** Pointer moved with no button pressed. */
  hover?(p: ToolPointer): void;
  /** Abort an in-progress interaction (e.g. a pinch started). */
  cancel?(): void;
  /** Return true if the key was handled. */
  keydown?(e: KeyboardEvent): boolean;
  overlay?(ctx: CanvasRenderingContext2D, view: Viewport): void;
  /** Builds the tool options bar contents. */
  options(): HTMLElement;
  activate?(): void;
  deactivate?(): void;
  /** True while the tool is mid-interaction (autosave waits). */
  readonly active?: boolean;
}

export type ToolFactory = (ed: Editor) => Tool;
