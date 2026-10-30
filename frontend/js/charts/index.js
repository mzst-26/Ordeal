// Hand-drawn SVG charts for Field Notes. Each chart draws into a host element and returns
// { update(nextOptions), destroy() }. The pages import from this file; the drawing lives in the modules it names.
export { lineBandChart } from "./line.js";
export { chooseLabelSide, cornerBoxes } from "./labels.js";
