// Plain-English meanings of the terms on the Batch results charts. Each one is shown when the reader hovers the
// term, so keep each to a sentence or two that a reader with no background can follow.

export const TERMS = {
  view: "Choose how the same models are drawn: a radar, a scatter plot or a profile.",
  radar: "A radar chart. Each spoke is one measure and each model is a shape. The outer edge is the best model on a measure and the centre is the worst, so a bigger shape is better.",
  scatter: "A scatter plot. Each dot is one model, placed by its two chosen measures: one along the bottom and one up the side.",
  profile: "A profile chart. Each model has its own row of eight bars, one for each measure. A taller bar is better.",
  xAxis: "The measure along the bottom of the chart. Pick any measure from the menu.",
  yAxis: "The measure up the left side of the chart. Pick any measure from the menu.",
  axisEnd: "The lowest or highest value on this axis among the ticked models.",
  legend: "Click a model to hide it from the chart. Click it again to show it.",
  barOrder: "The numbers 1 to 8 match the bars in each profile row, from left to right.",
  shareOfMax: "Each bar is the measure's value divided by the most it can ever be, so a full bar is the top of the scale, not the best model. Where lower is better, a short bar is the good one.",
  scaled: "Each measure is stretched across the ticked models. Where lower is better, the scale is flipped, so the best model is still the tallest bar or the outermost point.",
  notPlotted: "A dot needs a value for both chosen measures. Models without one are listed here instead.",
  noData: "This model has no value for this measure, so nothing is drawn for it.",
};
