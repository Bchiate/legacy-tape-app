import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/AuthProvider";

// Testing Mode is a flag on top of a real signed-in session, not a substitute
// for one — every protected page needs auth.uid() for RLS, Edge Functions and
// device ownership. (It used to let an unauthenticated admin through, which
// produced pages that silently did nothing.)
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
