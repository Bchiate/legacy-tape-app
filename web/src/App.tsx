import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/AuthProvider";
import ProtectedRoute from "@/components/ProtectedRoute";
import Auth from "./pages/Auth.tsx";
import Index from "./pages/Index.tsx";
import FollowStory from "./pages/FollowStory.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import RecordFlow from "./pages/RecordFlow.tsx";
import DeviceSetup from "./pages/DeviceSetup.tsx";
import CreatorHome from "./pages/CreatorHome.tsx";
import CreatorLibrary from "./pages/CreatorLibrary.tsx";
import CreatorProfile from "./pages/CreatorProfile.tsx";
import FollowerProfile from "./pages/FollowerProfile.tsx";
import RecordingSession from "./pages/RecordingSession.tsx";
import ManageDevice from "./pages/ManageDevice.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <HashRouter>
          <Routes>
            <Route path="/" element={<Auth />} />
            <Route path="/home" element={<ProtectedRoute><Index /></ProtectedRoute>} />
            <Route path="/follow" element={<ProtectedRoute><FollowStory /></ProtectedRoute>} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/record" element={<ProtectedRoute><RecordFlow /></ProtectedRoute>} />
            <Route path="/device-setup" element={<ProtectedRoute><DeviceSetup /></ProtectedRoute>} />
            <Route path="/creator-home" element={<ProtectedRoute><CreatorHome /></ProtectedRoute>} />
            <Route path="/creator-library" element={<ProtectedRoute><CreatorLibrary /></ProtectedRoute>} />
            <Route path="/creator-profile" element={<ProtectedRoute><CreatorProfile /></ProtectedRoute>} />
            <Route path="/follower-profile" element={<ProtectedRoute><FollowerProfile /></ProtectedRoute>} />
            <Route path="/recording-session" element={<ProtectedRoute><RecordingSession /></ProtectedRoute>} />
            <Route path="/manage-device" element={<ProtectedRoute><ManageDevice /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </HashRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
