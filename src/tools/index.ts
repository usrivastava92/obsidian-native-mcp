/**
 * Tool aggregation. Imports every tool definition and exposes a `registerAll`
 * helper that the server entry points (CLI + plugin) use.
 */

import type { ToolRegistry } from "../handlers/registry.js";
import { READ_TOOLS } from "./read.js";
import {
  fileCreateTool,
  fileReplaceTool,
  fileAppendTool,
  fileMoveTool,
  fileDeleteTool,
} from "./write-basic.js";
import {
  strReplaceTool,
  applyEditsTool,
  linesReplaceTool,
  linesInsertTool,
} from "./write-surgical.js";
import {
  headingReplaceBodyTool,
  headingRenameTool,
  blockReplaceTool,
  blockRenameTool,
  frontmatterSetTool,
  frontmatterDeleteTool,
} from "./write-structural.js";
import { applyPatchTool } from "./write-patch.js";
import { bulkApplyTool, regexReplaceTool } from "./write-bulk.js";

const WRITE_TOOLS = [
  // surgical primaries first
  strReplaceTool,
  applyPatchTool,
  applyEditsTool,
  // structural
  headingReplaceBodyTool,
  headingRenameTool,
  blockReplaceTool,
  blockRenameTool,
  frontmatterSetTool,
  frontmatterDeleteTool,
  linesReplaceTool,
  linesInsertTool,
  // whole-file / metadata
  fileCreateTool,
  fileReplaceTool,
  fileAppendTool,
  fileMoveTool,
  fileDeleteTool,
  // batch + power
  bulkApplyTool,
  regexReplaceTool,
];

export function registerAll(reg: ToolRegistry): void {
  for (const t of READ_TOOLS) reg.register(t);
  for (const t of WRITE_TOOLS) reg.register(t);
}
