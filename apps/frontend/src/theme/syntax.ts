import { SyntaxStyle, RGBA } from "@opentui/core";
import type { ThemeConfig } from "./builtinThemes";

/** 由主题色生成 <markdown>/<code> 用的 SyntaxStyle。 */
export function createSyntaxStyle(theme: ThemeConfig): SyntaxStyle {
  const c = theme.colors;
  return SyntaxStyle.fromStyles({
    "markup.heading.1": { fg: RGBA.fromHex(c.primary), bold: true },
    "markup.heading": { fg: RGBA.fromHex(c.primary), bold: true },
    "markup.list": { fg: RGBA.fromHex(c.accent) },
    "markup.raw": { fg: RGBA.fromHex(c.warning) },
    "markup.bold": { fg: RGBA.fromHex(c.foreground), bold: true },
    "markup.italic": { fg: RGBA.fromHex(c.foreground), italic: true },
    "markup.link.url": { fg: RGBA.fromHex(c.info), underline: true },
    comment: { fg: RGBA.fromHex(c.muted), italic: true },
    string: { fg: RGBA.fromHex(c.success) },
    keyword: { fg: RGBA.fromHex(c.accent) },
    function: { fg: RGBA.fromHex(c.info) },
    number: { fg: RGBA.fromHex(c.warning) },
    type: { fg: RGBA.fromHex(c.primary) },
    default: { fg: RGBA.fromHex(c.foreground) },
  });
}
