import katex from "katex";

export function renderMath(element, expression, displayMode) {
  katex.render(expression, element, { displayMode, throwOnError: false, trust: false });
}
