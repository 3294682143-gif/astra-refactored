import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "./layout/AppLayout";
import { WorkspacePage } from "./features/workspace/WorkspacePage";
import { RunsPage } from "./pages/runs/RunsPage";
import { BatchPage } from "./pages/batch/BatchPage";
import { AssetsPage } from "./pages/assets/AssetsPage";
import { SettingsPage } from "./pages/settings/SettingsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/solve" replace /> },
      { path: "solve", element: <WorkspacePage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId", element: <WorkspacePage /> },
      { path: "runs/:runId/replay", element: <WorkspacePage /> },
      { path: "batch", element: <BatchPage /> },
      { path: "assets", element: <AssetsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/solve" replace /> },
    ],
  },
]);
