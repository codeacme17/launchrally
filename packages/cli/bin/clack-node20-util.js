import {
  stripVTControlCharacters,
  styleText as nativeStyleText,
} from "node:util";

export { stripVTControlCharacters };

export function styleText(format, text) {
  if (!Array.isArray(format)) return nativeStyleText(format, text);
  return format.reduceRight(
    (styledText, currentFormat) => nativeStyleText(currentFormat, styledText),
    text,
  );
}
