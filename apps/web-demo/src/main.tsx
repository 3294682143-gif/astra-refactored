import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { router } from "./router";
import "./index.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("[web-demo] #root mount container not found");
}

createRoot(container).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
