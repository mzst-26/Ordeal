// The browser entry for the main page (index.html). It draws the React header, then starts the router in app.js,
// which shows one view at a time. The pages inside each view are still plain modules that mount into their section.

import { createRoot } from "react-dom/client";
import { startApp } from "./app.js";
import { vault } from "./engine/token.js";
import { SiteHeader } from "./react/SiteHeader.jsx";
import { mountPlatformSection } from "./platform-section.js";

startApp({
  renderHeader(navigate) {
    createRoot(document.getElementById("site-header")).render(<SiteHeader vault={vault} navigate={navigate} />);
  },
});

// The platform and model section sits in the batch view. It loads the shared platform list itself.
mountPlatformSection(document.getElementById("platform-section"));
