import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "./layout/AppLayout";
import { HomePage } from "./pages/home/HomePage";
import { SolvePage } from "./pages/solve/SolvePage";
import { ChatPage } from "./pages/chat/ChatPage";
import { RunsPage } from "./pages/runs/RunsPage";
import { RunDetailPage } from "./pages/runs/RunDetailPage";
import { RunReplayPage } from "./pages/replay/RunReplayPage";
import { BatchPage } from "./pages/batch/BatchPage";
import { ComparePage } from "./pages/batch/ComparePage";
import { ProtocolPage } from "./pages/protocol/ProtocolPage";
import { ResiliencePage } from "./pages/protocol/ResiliencePage";
import { AssetsPage } from "./pages/assets/AssetsPage";
import { SettingsPage } from "./pages/settings/SettingsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: "home", element: <HomePage /> },
      { path: "solve", element: <SolvePage /> },
      { path: "chat", element: <ChatPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId", element: <RunDetailPage /> },
      { path: "runs/:runId/replay", element: <RunReplayPage /> },
      { path: "batch", element: <BatchPage /> },
      { path: "batch/compare", element: <ComparePage /> },
      { path: "protocol", element: <ProtocolPage /> },
      { path: "protocol/resilience", element: <ResiliencePage /> },
      { path: "assets", element: <AssetsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/home" replace /> },
    ],
  },
]);
