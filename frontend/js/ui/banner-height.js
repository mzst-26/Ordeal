// Keeps the height of the storage banner in a CSS variable, so the levels drawer can start just below it.
//
// The banner is one line on a wide screen but can wrap to two on a narrower one, so its height is not a fixed
// number. The drawer is positioned with the variable --experiment-banner-height. This module measures the banner
// and writes that variable again whenever the banner changes size, so the drawer never hides under the banner.

/**
 * Measure the storage banner now, and again whenever its size changes.
 * It does nothing on a page without a banner, and it does nothing where ResizeObserver is not available,
 * because then the drawer keeps the default offset of 0 and still works.
 */
export function keepBannerHeight(doc = document) {
  const banner = doc.querySelector(".experiment-banner");
  if (!banner || typeof ResizeObserver === "undefined") return;

  // Write the current height of the banner into the variable that the drawer's CSS reads.
  const writeHeight = () => {
    doc.documentElement.style.setProperty("--experiment-banner-height", `${banner.offsetHeight}px`);
  };

  // The observer runs again on every resize of the banner, for example when the window narrows and the text wraps.
  new ResizeObserver(writeHeight).observe(banner);
  writeHeight();
}
