import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "./layout/AppLayout";
import { SolvePage } from "./pages/solve/SolvePage";
import { RunsPage } from "./pages/runs/RunsPage";
import { RunDetailPage } from "./pages/runs/RunDetailPage";
import { RunReplayPage } from "./pages/replay/RunReplayPage";
import { BatchPage } from "./pages/batch/BatchPage";
import { AssetsPage } from "./pages/assets/AssetsPage";
import { SettingsPage } from "./pages/settings/SettingsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/solve" replace /> },
      { path: "solve", element: <SolvePage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId", element: <RunDetailPage /> },
      { path: "runs/:runId/replay", element: <RunReplayPage /> },
      { path: "batch", element: <BatchPage /> },
      { path: "assets", element: <AssetsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/solve" replace /> },
    ],
  },
]);
