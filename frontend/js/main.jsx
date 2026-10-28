// The browser entry for the main page (index.html). It draws the React header, then starts the router in app.js,
// which shows one view at a time. The pages inside each view are still plain modules that mount into their section.

import { createRoot } from "react-dom/client";
import { startApp } from "./app.js";
import { vault } from "./engine/token.js";
import { SiteHeader } from "./react/SiteHeader.jsx";
import { mountPlatformSection } from "./models/platform-section.js";
import { keepBannerHeight } from "./ui/banner-height.js";

// Place the levels-drawer offset under the storage banner before the header and views are drawn.
keepBannerHeight();

startApp({
  renderHeader(navigate) {
    createRoot(document.getElementById("site-header")).render(<SiteHeader vault={vault} navigate={navigate} />);
  },
});

// The platform and key panel sits in the batch view and in the gauntlet view. It loads the shared platform list
// itself. Each copy is drawn into its own root, and the two copies share one saved choice (see platform-section.js).
mountPlatformSection(document.getElementById("platform-section"));
mountPlatformSection(document.getElementById("platform-section-gauntlet"));
