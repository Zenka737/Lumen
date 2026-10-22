import type { Editor } from '../core/editor';
import { EyedropperTool, FillTool, HandTool, MoveTool, ZoomTool } from './basic';
import { BrushTool } from './brush';
import { CropTool } from './crop';
import { CloneTool, GradientTool, HealTool } from './retouch';
import { LassoTool, MagicWandTool, MarqueeTool } from './selection';
import { ShapeTool } from './shape';
import { TextTool } from './text';
import type { Tool } from './tool';
import { TransformTool } from './transform';

/** Toolbox order. */
export function createTools(ed: Editor): Tool[] {
  return [
    new MoveTool(ed),
    new MarqueeTool(ed),
    new LassoTool(ed),
    new MagicWandTool(ed),
    new CropTool(ed),
    new EyedropperTool(ed),
    new BrushTool(ed, false),
    new BrushTool(ed, true),
    new CloneTool(ed),
    new HealTool(ed),
    new FillTool(ed),
    new GradientTool(ed),
    new TextTool(ed),
    new ShapeTool(ed),
    new HandTool(ed),
    new ZoomTool(ed),
    new TransformTool(ed),
  ];
}

/** Groups separated by dividers in the toolbox (the transform tool is started with ⌘/Ctrl+T). */
export const TOOL_GROUPS = [
  ['move', 'marquee', 'lasso', 'wand', 'crop'],
  ['eyedropper', 'brush', 'eraser', 'clone', 'heal', 'fill', 'gradient'],
  ['text', 'shape'],
  ['hand', 'zoom'],
];
